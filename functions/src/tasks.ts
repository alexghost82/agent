import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFunctions } from "firebase-admin/functions";
import { db } from "./firebase";
import { serverTime, logEvent } from "./util";
import { ingestRepo } from "./github";
import { bumpCounter } from "./stats";
import { decryptSecret, EncryptedSecret } from "./crypto";
import { AppError } from "./errors";
import { log } from "./log";

// Async repo ingestion (ADR-0002 / CONTRACT v3). Large GitHub repos can exceed
// the 120s request budget, so `connect-github` only ENQUEUES a job here and the
// heavy work runs out-of-band on a Cloud Tasks queue with retries/backoff.
// Progress and the final state are written to `projects/{id}` (`ingestStatus`).

export interface IngestPayload {
  userId: string;
  projectId: string;
  repoUrl: string;
  // Per-request nonce. Only the most recent queued request "owns" the project's
  // ingest; stale/retried tasks that lost the race are dropped (idempotency).
  ingestToken: string;
}

// How an enqueued job is dispatched:
//  - "tasks":  real Cloud Tasks queue (production).
//  - "inline": run out-of-band next tick (emulator / local dev) so the HTTP
//              endpoint still returns immediately, mirroring async semantics.
//  - "noop":   record the enqueue but do nothing (explicit test seam via
//              INGEST_INLINE=0, lets tests assert the queued state without
//              network or a Cloud Tasks emulator).
function dispatchMode(): "tasks" | "inline" | "noop" {
  if (process.env.INGEST_INLINE === "0") return "noop";
  if (
    process.env.INGEST_INLINE === "1" ||
    !!process.env.FUNCTIONS_EMULATOR ||
    !!process.env.FIRESTORE_EMULATOR_HOST
  ) {
    return "inline";
  }
  return "tasks";
}

// Reads the per-user GitHub token, decrypting the stored envelope. Supports a
// legacy plaintext value for backward compatibility during migration.
//
// IMPORTANT: a token that is STORED but cannot be decrypted (e.g. KEYS_ENC_SECRET
// was rotated since it was saved) is NOT silently dropped — that produced the
// confusing "my valid token doesn't work" symptom, because ingest then ran
// unauthenticated and a private repo 404'd. Instead we throw a permanent,
// user-actionable error so the project surfaces "re-save your token". When NO
// token is stored we still return undefined so public-repo ingest keeps working.
export function readGithubToken(data: FirebaseFirestore.DocumentData | undefined, userId: string): string | undefined {
  const t = data?.githubToken;
  if (!t) return undefined;
  if (typeof t === "string") return t; // legacy plaintext (pre-encryption)
  const env = t as Partial<EncryptedSecret>;
  if (env.ciphertext && env.iv && env.tag) {
    try {
      return decryptSecret(env as EncryptedSecret);
    } catch {
      log("warn", "github_token_decrypt_failed", { userId });
      throw new AppError(
        "github_token_invalid",
        400,
        "Saved GitHub token could not be decrypted (the server encryption secret changed). Re-enter your token and try again."
      );
    }
  }
  return undefined;
}

// GitHub errors that will never succeed on retry (bad repo / no access). For
// these we record the failure but do NOT rethrow, so Cloud Tasks stops retrying.
export function isPermanent(err: unknown): boolean {
  return (
    err instanceof AppError &&
    (err.code === "github_repo_unavailable" ||
      err.code === "github_access_denied" ||
      err.code === "github_token_invalid")
  );
}

// The actual ingest job. Exported (with an injectable `ingest` fn) so it can be
// driven directly from the Cloud Tasks handler, the inline fallback, and tests.
export async function runIngestJob(
  payload: IngestPayload,
  ingest: typeof ingestRepo = ingestRepo
): Promise<void> {
  const { userId, projectId, repoUrl, ingestToken } = payload;
  const ref = db.collection("projects").doc(projectId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    log("warn", "ingest_job_orphaned", { projectId, userId });
    return; // project deleted or not owned: drop the task, no retry
  }
  // Idempotency / staleness guard: a newer connect-github request bumps the
  // token, so only the latest one proceeds.
  const current = snap.data()?.ingestToken;
  if (current && current !== ingestToken) {
    log("info", "ingest_job_superseded", { projectId, ingestToken });
    return;
  }

  await ref.update({ ingestStatus: "ingesting", ingestedFiles: 0, updatedAt: serverTime() });
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const token = readGithubToken(userDoc.data(), userId);
    const result = await ingest({
      userId,
      projectId,
      repoUrl,
      token,
      onProgress: async (done, total) => {
        await ref.update({ ingestedFiles: done, ingestTotalFiles: total });
      }
    });

    // Re-check the token before finalizing so a newer request isn't clobbered
    // by this (possibly slower) run.
    const fresh = await ref.get();
    if (fresh.data()?.ingestToken && fresh.data()?.ingestToken !== ingestToken) {
      log("info", "ingest_result_discarded_superseded", { projectId });
      return;
    }

    await ref.update({
      repoUrl,
      defaultBranch: result.branch,
      summary: result.summary,
      ingestStatus: "ready",
      ingestedFiles: result.filesIndexed,
      ingestedChunks: result.chunks,
      ingestError: null,
      ingestedAt: serverTime(),
      updatedAt: serverTime()
    });
    await bumpCounter(userId, "knowledge_chunks", result.chunks);
    await logEvent(userId, "github_ingested", repoUrl, {
      projectId,
      files: result.filesIndexed,
      chunks: result.chunks
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ref.update({ ingestStatus: "error", ingestError: message, updatedAt: serverTime() }).catch(() => undefined);
    log("error", "ingest_job_failed", { projectId, message, permanent: isPermanent(err) });
    if (isPermanent(err)) return; // do not retry hopeless cases
    throw err; // transient: surface to Cloud Tasks for retry/backoff
  }
}

// Enqueues an ingest job. Returns as soon as the task is accepted.
export async function enqueueIngest(payload: IngestPayload): Promise<void> {
  const mode = dispatchMode();
  if (mode === "noop") return;
  if (mode === "inline") {
    setImmediate(() => {
      runIngestJob(payload).catch((err) =>
        log("warn", "inline_ingest_failed", {
          projectId: payload.projectId,
          message: err instanceof Error ? err.message : String(err)
        })
      );
    });
    return;
  }
  const queue = getFunctions().taskQueue("ingestWorker");
  await queue.enqueue(payload, { dispatchDeadlineSeconds: 600 });
}

// Cloud Tasks handler. Retries with exponential backoff; OIDC auth is enforced
// by the platform (only the queue can invoke it).
export const ingestWorker = onTaskDispatched<IngestPayload>(
  {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 300 },
    rateLimits: { maxConcurrentDispatches: 6 },
    memory: "1GiB",
    timeoutSeconds: 540
  },
  async (req) => {
    await runIngestJob(req.data);
  }
);
