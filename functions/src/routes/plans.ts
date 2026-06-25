import { Router, Response } from "express";
import { db } from "../firebase";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { sendError, notFound } from "../errors";
import { GeneratePlanSchema } from "../schemas";
import { assertAiKeyAvailable } from "../ai";
import { createAiJob, enqueueAiJob } from "../aiJobs";

export const plansRouter = Router();

plansRouter.get("/generated-plans", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const plans = await listScoped({
      collection: "generated_plans",
      userId: req.userId!,
      where: projectId ? [["projectId", projectId]] : [],
      limit: 50
    });
    res.json({ plans });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Plan generation is slow (multiple detailed md files) and routinely exceeds
// Firebase Hosting's 60s rewrite timeout, so this only validates + ENQUEUES an
// async job (see aiJobs.ts) and returns 202 with a jobId. The client polls
// GET /ai-jobs/:id for the result. Ownership + key checks stay synchronous so
// the caller still gets immediate 400/404 on bad input.
plansRouter.post("/generate-plan", rateLimit("generate-plan", 12, 60_000), distributedRateLimit("generate-plan", 80, 3_600_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, instructions, lang } = GeneratePlanSchema.parse(req.body);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    await assertAiKeyAvailable(req.userId!);
    const jobId = await createAiJob({
      userId: req.userId!,
      kind: "plan",
      projectId,
      params: { instructions: instructions ?? null, lang: lang ?? null }
    });
    await enqueueAiJob(jobId);
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    sendError(req, res, err);
  }
});
