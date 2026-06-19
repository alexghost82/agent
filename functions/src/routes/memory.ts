import { Router, Response } from "express";
import { db } from "../firebase";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";

// Memory transparency (CONTRACT v3.6): the user can view and delete their own
// knowledge chunks. The raw embedding vector is never returned.
export const memoryRouter = Router();

memoryRouter.get("/memory", async (req: AuthedRequest, res: Response) => {
  try {
    const topicId = typeof req.query.topicId === "string" ? req.query.topicId : null;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const where: [string, unknown][] = [];
    if (topicId) where.push(["topicId", topicId]);
    if (projectId) where.push(["projectId", projectId]);
    const rows = await listScoped({ collection: "knowledge_chunks", userId: req.userId!, where, limit });
    const chunks = rows.map((c) => ({
      id: c.id,
      title: c.title ?? c.sourcePath ?? null,
      sourceUrl: c.sourceUrl ?? null,
      sourcePath: c.sourcePath ?? null,
      chunkType: c.chunkType ?? null,
      scope: c.scope ?? null,
      topicId: c.topicId ?? null,
      projectId: c.projectId ?? null,
      preview: typeof c.content === "string" ? c.content.slice(0, 280) : "",
      createdAt: c.createdAt ?? null
    }));
    res.json({ chunks });
  } catch (err) {
    sendError(req, res, err);
  }
});

memoryRouter.delete("/memory/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const ref = db.collection("knowledge_chunks").doc(String(req.params.id));
    const doc = await ref.get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    await ref.delete();
    await bumpCounter(req.userId!, "knowledge_chunks", -1);
    res.json({ status: "deleted" });
  } catch (err) {
    sendError(req, res, err);
  }
});
