import { Router, Response } from "express";
import { db } from "../firebase";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { sendError, notFound } from "../errors";
import { DesignSchema } from "../schemas";
import { assertAiKeyAvailable } from "../ai";
import { createAiJob, enqueueAiJob } from "../aiJobs";

export const designRouter = Router();

designRouter.get("/design", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const decisions = await listScoped({
      collection: "project_decisions",
      userId: req.userId!,
      where: projectId ? [["projectId", projectId]] : [],
      limit: 50
    });
    res.json({ decisions });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Design generation is LLM-bound and can exceed Firebase Hosting's 60s rewrite
// timeout, so this only validates + ENQUEUES an async job (see aiJobs.ts) and
// returns 202 with a jobId; the client polls GET /ai-jobs/:id for the result.
designRouter.post("/design", rateLimit("design", 20, 60_000), distributedRateLimit("design", 100, 3_600_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, section, topicIds, lang } = DesignSchema.parse(req.body);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    await assertAiKeyAvailable(req.userId!);
    const jobId = await createAiJob({
      userId: req.userId!,
      kind: "design",
      projectId,
      params: { section: section ?? null, topicIds: topicIds ?? [], lang: lang ?? null }
    });
    await enqueueAiJob(jobId);
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    sendError(req, res, err);
  }
});
