import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFunctions } from "firebase-admin/functions";
import { db } from "./firebase";
import { serverTime } from "./util";
import { log } from "./log";
import { AppError } from "./errors";
import { runPlanCore } from "./plan";
import { runDesignCore } from "./designCore";
import { runBuildCore } from "./buildJob";
import { extractSkillsForTopic } from "./skillsCore";
import { runAgentCore } from "./agentCore";

// Generic async runner for the slow, LLM-bound endpoints (plan / build / design).
// These routinely exceed Firebase Hosting's 60s rewrite timeout, so the HTTP
// routes only ENQUEUE a job here and the heavy work runs out of band on a Cloud
// Tasks queue with retries — mirroring the repo-ingest (tasks.ts) and project
// scan (projectScan.ts) workers. Status + result land on the `ai_jobs` doc,
// which the client polls via GET /ai-jobs/:id.

export type AiJobKind = "plan" | "build" | "design" | "skills" | "agent";

export interface CreateAiJobInput {
  userId: string;
  kind: AiJobKind;
  // For project-bound jobs (plan/build/design) this is the projectId; for
  // "skills" jobs it carries the topicId so the job stays owner+scope addressable.
  projectId: string;
  params: Record<string, unknown>;
}

interface AiJobPayload {
  jobId: string;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Creates the job record (status "queued") and returns its id.
export async function createAiJob(input: CreateAiJobInput): Promise<string> {
  const ref = await db.collection("ai_jobs").add({
    userId: input.userId,
    kind: input.kind,
    projectId: input.projectId,
    params: input.params,
    status: "queued",
    result: null,
    errorCode: null,
    createdAt: serverTime(),
    updatedAt: serverTime()
  });
  return ref.id;
}

// How an enqueued job is dispatched (mirrors tasks.ts / projectScan.ts):
//  - "tasks":  real Cloud Tasks queue (production).
//  - "inline": run out-of-band next tick (emulator / local dev) so the HTTP
//              endpoint still returns immediately, mirroring async semantics.
//  - "noop":   record the enqueue but do nothing (AI_JOB_INLINE=0 test seam).
function dispatchMode(): "tasks" | "inline" | "noop" {
  if (process.env.AI_JOB_INLINE === "0") return "noop";
  if (
    process.env.AI_JOB_INLINE === "1" ||
    !!process.env.FUNCTIONS_EMULATOR ||
    !!process.env.FIRESTORE_EMULATOR_HOST
  ) {
    return "inline";
  }
  return "tasks";
}

// Enqueues a job for background execution. Returns as soon as it is accepted.
export async function enqueueAiJob(jobId: string): Promise<void> {
  const mode = dispatchMode();
  if (mode === "noop") return;
  if (mode === "inline") {
    setImmediate(() => {
      runAiJob(jobId).catch((err) => log("warn", "inline_ai_job_failed", { jobId, message: msg(err) }));
    });
    return;
  }
  const queue = getFunctions().taskQueue("aiJobWorker");
  await queue.enqueue({ jobId }, { dispatchDeadlineSeconds: 600 });
}

// Errors that will never succeed on retry: validation/ownership (AppError) and
// the no-key boundary. For these we record the failure but do NOT rethrow, so
// Cloud Tasks stops retrying.
function isPermanent(err: unknown): boolean {
  if (err instanceof AppError) return true;
  if (err instanceof Error && err.message === "no_api_key") return true;
  return false;
}

// Runs a single job by id. Exported so the inline fallback, the Cloud Tasks
// handler and tests can all drive it directly.
export async function runAiJob(jobId: string): Promise<void> {
  const ref = db.collection("ai_jobs").doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    log("warn", "ai_job_missing", { jobId });
    return; // job deleted: drop the task, no retry
  }
  const job = snap.data()!;
  if (job.status === "done") return; // idempotent: a retry of a finished job

  await ref.update({ status: "running", updatedAt: serverTime() });
  try {
    const userId = job.userId as string;
    const projectId = job.projectId as string;
    const params = (job.params || {}) as Record<string, unknown>;
    let result: unknown;

    if (job.kind === "plan") {
      result = await runPlanCore({
        userId,
        projectId,
        instructions: (params.instructions as string) || undefined,
        lang: (params.lang as string) || undefined
      });
    } else if (job.kind === "design") {
      result = await runDesignCore({
        userId,
        projectId,
        section: (params.section as string | null) ?? null,
        topicIds: (params.topicIds as string[]) || [],
        lang: (params.lang as string) || undefined
      });
    } else if (job.kind === "build") {
      result = await runBuildCore({
        userId,
        projectId,
        planId: (params.planId as string) || undefined,
        instructions: (params.instructions as string) || undefined,
        lang: (params.lang as string) || undefined
      });
    } else if (job.kind === "skills") {
      // Skills jobs are topic-scoped: projectId carries the topicId.
      const topicId = (params.topicId as string) || projectId;
      result = await extractSkillsForTopic(userId, topicId, (params.topicName as string) || "");
    } else if (job.kind === "agent") {
      // Autonomous agent (Autopilot): projectId carries the agent_runs doc id the
      // orchestration streams progress into. On failure we also flip that run doc
      // to "error" so the polling UI stops waiting (the ai_jobs doc records it too).
      const runId = (params.runId as string) || projectId;
      try {
        result = await runAgentCore({
          userId,
          runId,
          urls: (params.urls as string[]) || [],
          task: (params.task as string) || "",
          deep: !!params.deep,
          lang: (params.lang as string) || undefined
        });
      } catch (agentErr) {
        const code =
          agentErr instanceof AppError
            ? agentErr.code
            : agentErr instanceof Error && agentErr.message === "no_api_key"
              ? "no_api_key"
              : "internal";
        await db
          .collection("agent_runs")
          .doc(runId)
          .update({ status: "error", errorCode: code, updatedAt: serverTime() })
          .catch(() => undefined);
        throw agentErr;
      }
    } else {
      throw new Error("unknown_job_kind");
    }

    await ref.update({ status: "done", result, errorCode: null, updatedAt: serverTime() });
  } catch (err) {
    const code = err instanceof AppError ? err.code : err instanceof Error && err.message === "no_api_key" ? "no_api_key" : "internal";
    await ref.update({ status: "error", errorCode: code, updatedAt: serverTime() }).catch(() => undefined);
    log("error", "ai_job_failed", { jobId, kind: job.kind, code, message: msg(err) });
    if (isPermanent(err)) return; // hopeless: stop retrying
    throw err; // transient: surface to Cloud Tasks for retry/backoff
  }
}

// Cloud Tasks handler. Retries with backoff; platform OIDC restricts the caller.
export const aiJobWorker = onTaskDispatched<AiJobPayload>(
  {
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30, maxBackoffSeconds: 300 },
    rateLimits: { maxConcurrentDispatches: 6 },
    memory: "1GiB",
    timeoutSeconds: 540
  },
  async (req) => {
    await runAiJob(req.data.jobId);
  }
);
