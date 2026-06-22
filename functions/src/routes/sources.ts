import { Router, Response } from "express";
import { db } from "../firebase";
import { logEvent } from "../util";
import { ingestUrl } from "../learn";
import { recordUsage } from "../usage";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScopedPage } from "../listing";
import { sendError, notFound } from "../errors";
import { LearnSchema } from "../schemas";

export const sourcesRouter = Router();

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

      // Shared ingestion (Epic 3.1): fetch + chunk + embed + store + summarize.
      const result = await ingestUrl({ userId: req.userId!, topicId, url, tags, deep });
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
