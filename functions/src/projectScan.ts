import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFunctions } from "firebase-admin/functions";
import { db } from "./firebase";
import { serverTime, logEvent } from "./util";
import { log } from "./log";
import { readGithubToken, isPermanent } from "./tasks";
import { runProjectScan, type RunProjectScanDeps } from "./project-intelligence";
import { updateScan } from "./project-intelligence/storage/persist";
import type { ScanOptions } from "./project-intelligence/types";

// Async project scan (mirrors the repo-ingest worker in tasks.ts). The
// `/projects/:id/scan` route only ENQUEUES; the heavy analysis runs here out of
// band with retries. Progress + final state land on the scan doc and a summary
// is mirrored onto the project doc for the projects list.

export interface ScanPayload {
  userId: string;
  projectId: string;
  scanId: string;
  repoUrl: string;
  // Per-request nonce: only the latest queued scan for a project "owns" it.
  scanToken: string;
  options: ScanOptions;
}

function dispatchMode(): "tasks" | "inline" | "noop" {
  if (process.env.SCAN_INLINE === "0") return "noop";
  if (
    process.env.SCAN_INLINE === "1" ||
    !!process.env.FUNCTIONS_EMULATOR ||
    !!process.env.FIRESTORE_EMULATOR_HOST
  ) {
    return "inline";
  }
  return "tasks";
}

// The actual scan job. `deps` is injectable so tests can stub the network scan.
export async function runScanJob(payload: ScanPayload, deps: RunProjectScanDeps = {}): Promise<void> {
  const { userId, projectId, scanId, repoUrl, scanToken } = payload;
  const projectRef = db.collection("projects").doc(projectId);
  const snap = await projectRef.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    log("warn", "scan_job_orphaned", { projectId, userId });
    return; // project deleted or not owned: drop the task, no retry
  }
  // Supersession guard: a newer scan request bumps the project's scanToken.
  const current = snap.data()?.scanToken;
  if (current && current !== scanToken) {
    log("info", "scan_job_superseded", { projectId, scanId });
    await updateScan(scanId, { status: "failed", phase: "superseded", error: "superseded by a newer scan" }).catch(() => undefined);
    return;
  }

  await projectRef
    .update({ scanStatus: "scanning", scanError: null, mapStatus: "building", mapError: null, updatedAt: serverTime() })
    .catch(() => undefined);

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const token = readGithubToken(userDoc.data(), userId);

    const result = await runProjectScan(
      {
        userId,
        projectId,
        projectName: (snap.data()?.name as string) || "Project",
        projectDescription: (snap.data()?.description as string) || "",
        scanId,
        repoUrl,
        token,
        options: payload.options || {}
      },
      deps
    );

    await projectRef.update({
      scanStatus: "completed",
      lastScanId: scanId,
      scanError: null,
      lastScannedAt: serverTime(),
      // Mirror a compact map summary onto the project doc so the projects list
      // can show status + node/edge counts without loading the full map.
      mapStatus: "ready",
      mapNodeCount: result.counts.nodes,
      mapEdgeCount: result.counts.edges,
      mapError: null,
      mapUpdatedAt: serverTime(),
      updatedAt: serverTime()
    });
    await logEvent(userId, "project_scanned", repoUrl, { projectId, scanId, ...result.counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateScan(scanId, { status: "failed", phase: "error", error: message }).catch(() => undefined);
    await projectRef
      .update({ scanStatus: "failed", scanError: message, mapStatus: "error", mapError: message, updatedAt: serverTime() })
      .catch(() => undefined);
    log("error", "scan_job_failed", { projectId, scanId, message, permanent: isPermanent(err) });
    if (isPermanent(err)) return; // hopeless: stop retrying
    throw err; // transient: let Cloud Tasks retry
  }
}

// Enqueues a scan job. Returns as soon as the task is accepted.
export async function enqueueScan(payload: ScanPayload): Promise<void> {
  const mode = dispatchMode();
  if (mode === "noop") return;
  if (mode === "inline") {
    setImmediate(() => {
      runScanJob(payload).catch((err) =>
        log("warn", "inline_scan_failed", {
          projectId: payload.projectId,
          message: err instanceof Error ? err.message : String(err)
        })
      );
    });
    return;
  }
  const queue = getFunctions().taskQueue("scanWorker");
  await queue.enqueue(payload, { dispatchDeadlineSeconds: 600 });
}

// Cloud Tasks handler. Retries with backoff; platform OIDC restricts the caller.
export const scanWorker = onTaskDispatched<ScanPayload>(
  {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 300 },
    rateLimits: { maxConcurrentDispatches: 4 },
    memory: "1GiB",
    timeoutSeconds: 540
  },
  async (req) => {
    await runScanJob(req.data);
  }
);
