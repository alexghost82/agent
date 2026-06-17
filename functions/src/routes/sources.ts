import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { tsMillis, chunkText } from "../pure";
import { embedding } from "../ai";
import { readUrl } from "../ssrf";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { LearnSchema } from "../schemas";

export const sourcesRouter = Router();

sourcesRouter.get("/sources", async (req: AuthedRequest, res: Response) => {
  try {
    const topicId = typeof req.query.topicId === "string" ? req.query.topicId : null;
    let q: FirebaseFirestore.Query = db.collection("sources").where("userId", "==", req.userId);
    if (topicId) q = q.where("topicId", "==", topicId);
    const snap = await q.limit(200).get();
    const sources = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    res.json({ sources });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "sources_failed" });
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
        res.status(404).json({ error: "Topic not found" });
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

      let saved = 0;
      for (let i = 0; i < chunks.length; i += 25) {
        const part = chunks.slice(i, i + 25);
        const embeddings = await Promise.all(part.map((c) => embedding(c)));
        const batch = db.batch();
        part.forEach((c, idx) => {
          const ref = db.collection("knowledge_chunks").doc();
          batch.set(ref, {
            userId: req.userId,
            scope: "topic",
            topicId,
            sourceId: sourceRef.id,
            sourceUrl: url,
            title: page.title,
            content: c,
            embedding: embeddings[idx],
            chunkType: "fact",
            confidence: 0.75,
            tags: tags || [],
            createdAt: serverTime()
          });
        });
        await batch.commit();
        saved += part.length;
      }

      await logEvent(req.userId!, "research_completed", `Saved ${saved} chunks from ${url}`, {
        sourceId: sourceRef.id,
        saved
      });
      res.json({ status: "saved", title: page.title, url, chunks: saved, sourceId: sourceRef.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "learn_failed" });
    }
  }
);
