import { Router, Response } from "express";
import { db } from "../firebase";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { sendError, notFound } from "../errors";
import { BuildSchema } from "../schemas";
import { assertAiKeyAvailable } from "../ai";
import { createAiJob, enqueueAiJob } from "../aiJobs";

export const buildRouter = Router();

// List build runs for the caller (optionally narrowed to one project).
buildRouter.get("/builds", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const runs = await listScoped({
      collection: "build_runs",
      userId: req.userId!,
      where: projectId ? [["projectId", projectId]] : [],
      limit: 50
    });
    res.json({ runs });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Fetch a single owned build run together with its generated artifacts.
buildRouter.get("/builds/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await db.collection("build_runs").doc(String(req.params.id)).get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const artifacts = await listScoped({
      collection: "build_artifacts",
      userId: req.userId!,
      where: [["buildRunId", doc.id]],
      limit: 200
    });
    artifacts.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    res.json({ run: { id: doc.id, ...doc.data() }, artifacts });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Real-development BUILD: generates real project files from the plan + skills +
// memory into an isolated Firestore workspace. NEVER writes to GitHub.
//
// Generation is LLM-bound (plus verification + an optional auto-fix pass) and
// routinely exceeds Firebase Hosting's 60s rewrite timeout, so this only
// validates + ENQUEUES an async job (see aiJobs.ts / buildJob.ts) and returns
// 202 with a jobId. The job's `result.id` is the build_run id; the client polls
// GET /ai-jobs/:id and then loads files via GET /builds/:id. Ownership + plan
// ownership + key checks stay synchronous for immediate 400/404 on bad input.
buildRouter.post(
  "/projects/:id/build",
  rateLimit("build", 6, 60_000),
  distributedRateLimit("build", 40, 3_600_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { planId, instructions, lang } = BuildSchema.parse(req.body);
      const projectId = String(req.params.id);

      const projDoc = await db.collection("projects").doc(projectId).get();
      if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
        sendError(req, res, notFound());
        return;
      }

      // Optional source plan must be owned by the caller.
      if (planId) {
        const planDoc = await db.collection("generated_plans").doc(planId).get();
        if (!planDoc.exists || planDoc.data()?.userId !== req.userId) {
          sendError(req, res, notFound());
          return;
        }
      }

      await assertAiKeyAvailable(req.userId!);
      const jobId = await createAiJob({
        userId: req.userId!,
        kind: "build",
        projectId,
        params: { planId: planId ?? null, instructions: instructions ?? null, lang: lang ?? null }
      });
      await enqueueAiJob(jobId);
      res.status(202).json({ jobId, status: "queued" });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
