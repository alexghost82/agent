import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { chunkText } from "../pure";
import { embeddingBatch } from "../ai";
import { readUrl } from "../ssrf";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { LearnSchema } from "../schemas";

export const sourcesRouter = Router();

const EMBED_BATCH = Number(process.env.EMBED_BATCH_SIZE) || 96;
const WRITE_BATCH = 400;

sourcesRouter.get("/sources", async (req: AuthedRequest, res: Response) => {
  try {
    const topicId = typeof req.query.topicId === "string" ? req.query.topicId : null;
    const sources = await listScoped({
      collection: "sources",
      userId: req.userId!,
      where: topicId ? [["topicId", topicId]] : []
    });
    res.json({ sources });
  } catch (err) {
    sendError(req, res, err);
  }
});

sourcesRouter.post(
  "/learn",
  rateLimit("learn", 20, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { url, tags, topicId } = LearnSchema.parse(req.body);
      const topicDoc = await db.collection("topics").doc(topicId).get();
      if (!topicDoc.exists || topicDoc.data()?.userId !== req.userId) {
        sendError(req, res, notFound());
        return;
      }
      await logEvent(req.userId!, "research_started", `Learning ${url}`, { url, topicId });
      const page = await readUrl(url);
      const chunks = chunkText(page.text);

      const sourceRef = await db.collection("sources").add({
        userId: req.userId,
        topicId,
        url,
        title: page.title,
        tags: tags || [],
        chunkCount: chunks.length,
        createdAt: serverTime()
      });
      await bumpCounter(req.userId!, "sources");

      let saved = 0;
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const part = chunks.slice(i, i + EMBED_BATCH);
        const embeddings = await embeddingBatch(part, req.userId!);
        for (let j = 0; j < part.length; j += WRITE_BATCH) {
          const slice = part.slice(j, j + WRITE_BATCH);
          const batch = db.batch();
          slice.forEach((c, idx) => {
            const ref = db.collection("knowledge_chunks").doc();
            batch.set(ref, {
              userId: req.userId,
              scope: "topic",
              topicId,
              sourceId: sourceRef.id,
              sourceUrl: url,
              title: page.title,
              content: c,
              embedding: embeddings[j + idx],
              chunkType: "fact",
              confidence: 0.75,
              tags: tags || [],
              createdAt: serverTime()
            });
          });
          await batch.commit();
          saved += slice.length;
        }
      }
      await bumpCounter(req.userId!, "knowledge_chunks", saved);

      await logEvent(req.userId!, "research_completed", `Saved ${saved} chunks from ${url}`, {
        sourceId: sourceRef.id,
        saved
      });
      res.json({ status: "saved", title: page.title, url, chunks: saved, sourceId: sourceRef.id });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
