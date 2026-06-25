import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { sendError, notFound } from "../errors";
import { AgentRunSchema } from "../schemas";
import { assertAiKeyAvailable } from "../ai";
import { createAiJob, enqueueAiJob } from "../aiJobs";

// Autonomous agent (Autopilot): a single call orchestrates the WHOLE cycle —
// links + task → learn → extract skills → auto-pick skills → design → plan →
// verified build. The orchestration is LLM-bound and routinely exceeds Firebase
// Hosting's 60s rewrite timeout, so the route only validates + ENQUEUES an async
// job (see aiJobs.ts / agentCore.ts) and returns 202 with the run id. Progress is
// streamed into the `agent_runs` doc (status + steps); the client polls
// GET /agent/runs/:id until it reaches "ready" (or "error").
export const agentRouter = Router();

// Owner-scoped fetch of a single agent run with its steps.
agentRouter.get("/agent/runs/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await db.collection("agent_runs").doc(String(req.params.id)).get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    res.json({ run: { id: doc.id, ...doc.data() } });
  } catch (err) {
    sendError(req, res, err);
  }
});

// List the caller's agent runs (owner-scoped, newest first).
agentRouter.get("/agent/runs", async (req: AuthedRequest, res: Response) => {
  try {
    const runs = await listScoped({ collection: "agent_runs", userId: req.userId!, limit: 50 });
    res.json({ runs });
  } catch (err) {
    sendError(req, res, err);
  }
});

agentRouter.post(
  "/agent/run",
  rateLimit("agent-run", 3, 60_000),
  distributedRateLimit("agent-run", 20, 3_600_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { urls, task, deep, lang } = AgentRunSchema.parse(req.body);
      const userId = req.userId!;

      // Fast-fail the missing-key boundary BEFORE creating the run doc / enqueueing,
      // so a keyless caller gets a synchronous 400 and nothing is materialized.
      await assertAiKeyAvailable(userId);

      const name = task.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 120) || "Agent run";
      const runRef = await db.collection("agent_runs").add({
        userId,
        task,
        urls,
        status: "queued",
        steps: [],
        topicId: null,
        projectId: null,
        buildRunId: null,
        summary: null,
        verification: null,
        errorCode: null,
        createdAt: serverTime(),
        updatedAt: serverTime()
      });
      await logEvent(userId, "agent_run_started", name, { runId: runRef.id, urls: urls.length });

      const jobId = await createAiJob({
        userId,
        kind: "agent",
        // projectId carries the run doc id so the job stays owner+scope addressable.
        projectId: runRef.id,
        params: { runId: runRef.id, urls, task, deep: deep ?? false, lang: lang ?? null }
      });
      await enqueueAiJob(jobId);

      res.status(202).json({ runId: runRef.id, jobId, status: "queued" });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
