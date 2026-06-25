import { Router, Response } from "express";
import { db } from "../firebase";
import { logEvent } from "../util";
import { ingestUrl } from "../learn";
import { readGithubToken } from "../tasks";
import { recordUsage } from "../usage";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScopedPage } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { LearnSchema } from "../schemas";

export const sourcesRouter = Router();

// Delete every knowledge chunk produced by one source, in bounded batches so a
// source with many chunks can't exceed Firestore's 500-write batch limit. Two
// equality filters need no composite index (single-field indexes suffice).
async function deleteChunksBySource(userId: string, sourceId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await db
      .collection("knowledge_chunks")
      .where("userId", "==", userId)
      .where("sourceId", "==", sourceId)
      .limit(400)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 400) break;
  }
  return deleted;
}

sourcesRouter.get("/sources", async (req: AuthedRequest, res: Response) => {
  try {
    const topicId = typeof req.query.topicId === "string" ? req.query.topicId : null;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const { items, nextCursor } = await listScopedPage({
      collection: "sources",
      userId: req.userId!,
      where: topicId ? [["topicId", topicId]] : [],
      cursor,
      pageSize: limit
    });
    // Additive paginated shape: `sources` is preserved for existing consumers,
    // `items`/`nextCursor` expose cursor pagination (nextCursor null = exhausted).
    res.json({ sources: items, items, nextCursor });
  } catch (err) {
    sendError(req, res, err);
  }
});

sourcesRouter.post(
  "/learn",
  rateLimit("learn", 20, 60_000),
  distributedRateLimit("learn", 150, 3_600_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { url, tags, topicId, deep } = LearnSchema.parse(req.body);
      const topicDoc = await db.collection("topics").doc(topicId).get();
      if (!topicDoc.exists || topicDoc.data()?.userId !== req.userId) {
        sendError(req, res, notFound());
        return;
      }
      await logEvent(req.userId!, "research_started", `Learning ${url}`, { url, topicId, deep: !!deep });

      // Use the caller's stored GitHub PAT (if any) so repo links authenticate as
      // the user rather than hitting GitHub's anonymous 60 req/hour rate limit.
      const userDoc = await db.collection("users").doc(req.userId!).get();
      const githubToken = readGithubToken(userDoc.data(), req.userId!);

      // Shared ingestion (Epic 3.1): fetch + chunk + embed + store + summarize.
      const result = await ingestUrl({ userId: req.userId!, topicId, url, tags, deep, githubToken });
      await recordUsage(req.userId!, "ingest");

      await logEvent(req.userId!, "research_completed", `Saved ${result.chunks} chunks from ${url}`, {
        sourceId: result.sourceId,
        saved: result.chunks,
        skipped: result.skipped,
        pages: result.pages,
        summarized: result.summarized
      });
      res.json({ status: "saved", title: result.title, url, pages: result.pages, chunks: result.chunks, skipped: result.skipped, summarized: result.summarized, sourceId: result.sourceId });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);

// Delete an owned source and all of its derived knowledge chunks, so removing a
// source leaves no orphaned memory behind (mirrors the project-delete cascade).
sourcesRouter.delete("/sources/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const doc = await db.collection("sources").doc(id).get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const userId = req.userId!;
    const chunks = await deleteChunksBySource(userId, id);
    await doc.ref.delete();
    await bumpCounter(userId, "sources", -1);
    if (chunks) await bumpCounter(userId, "knowledge_chunks", -chunks);
    await logEvent(userId, "source_deleted", String(doc.data()?.url || id), { id, chunks });
    res.json({ id, status: "deleted", chunks });
  } catch (err) {
    sendError(req, res, err);
  }
});
