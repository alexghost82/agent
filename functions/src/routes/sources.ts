import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { chunkText, contentHash } from "../pure";
import { embeddingBatch } from "../ai";
import { readUrl, crawlSite, type CrawledPage } from "../ssrf";
import { existingHashesForSource } from "../learn";
import { recordUsage } from "../usage";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
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

      // Single page (default) or a bounded same-origin crawl (CONTRACT v3.5).
      const pages: CrawledPage[] = deep
        ? await crawlSite(url)
        : [{ url, ...(await readUrl(url)) }];
      if (!pages.length) pages.push({ url, ...(await readUrl(url)) });
      const rootTitle = pages[0]?.title || url;

      const sourceRef = await db.collection("sources").add({
        userId: req.userId,
        topicId,
        url,
        title: rootTitle,
        tags: tags || [],
        deep: !!deep,
        pageCount: pages.length,
        chunkCount: 0,
        createdAt: serverTime()
      });
      await bumpCounter(req.userId!, "sources");

      // Dedup across the whole crawl + against prior /learn of the same URLs.
      const seenNow = new Set<string>();
      let saved = 0;
      let skipped = 0;
      for (const page of pages) {
        const allChunks = chunkText(page.text);
        const known = await existingHashesForSource(req.userId!, page.url);
        const chunks: { text: string; hash: string }[] = [];
        for (const text of allChunks) {
          const hash = contentHash(text);
          if (known.has(hash) || seenNow.has(hash)) { skipped += 1; continue; }
          seenNow.add(hash);
          chunks.push({ text, hash });
        }
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          const part = chunks.slice(i, i + EMBED_BATCH);
          const embeddings = await embeddingBatch(part.map((p) => p.text), req.userId!);
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
                sourceUrl: page.url,
                title: page.title,
                content: c.text,
                embedding: embeddings[j + idx],
                chunkType: "fact",
                confidence: 0.75,
                contentHash: c.hash,
                tags: tags || [],
                createdAt: serverTime()
              });
            });
            await batch.commit();
            saved += slice.length;
          }
        }
      }
      await sourceRef.update({ chunkCount: saved });
      await bumpCounter(req.userId!, "knowledge_chunks", saved);
      await recordUsage(req.userId!, "ingest");

      await logEvent(req.userId!, "research_completed", `Saved ${saved} chunks from ${url}`, {
        sourceId: sourceRef.id,
        saved,
        skipped,
        pages: pages.length
      });
      res.json({ status: "saved", title: rootTitle, url, pages: pages.length, chunks: saved, skipped, sourceId: sourceRef.id });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
