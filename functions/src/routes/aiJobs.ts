import { Router, Response } from "express";
import { db } from "../firebase";
import { AuthedRequest } from "../auth";
import { sendError, notFound } from "../errors";

export const aiJobsRouter = Router();

// Poll a single async AI job (plan / build / design). Owner-scoped. The client
// posts to /generate-plan, /design or /projects/:id/build (which return a jobId)
// and then polls this until status is "done" (result present) or "error".
aiJobsRouter.get("/ai-jobs/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await db.collection("ai_jobs").doc(String(req.params.id)).get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const d = doc.data()!;
    res.json({
      id: doc.id,
      kind: d.kind,
      status: d.status,
      projectId: d.projectId,
      result: d.result ?? null,
      errorCode: d.errorCode ?? null
    });
  } catch (err) {
    sendError(req, res, err);
  }
});
