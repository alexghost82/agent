/**
 * Unit tests — async job dispatch (tasks.ts + projectScan.ts).
 *
 * Mocks `../src/firebase` (db) and `firebase-admin/functions` (the Cloud Tasks
 * queue) so we can drive enqueueIngest/enqueueScan across all three dispatch
 * modes — noop (explicit test seam), inline (emulator/local), and tasks
 * (production queue) — with no network or real queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fb = vi.hoisted(() => {
  const snap = { exists: false, data: () => undefined as any };
  const docApi = { get: vi.fn(async () => snap), update: vi.fn(async () => {}) };
  const collection = vi.fn(() => ({ doc: vi.fn(() => docApi) }));
  return { collection, docApi, snap };
});

const fns = vi.hoisted(() => {
  const enqueue = vi.fn(async () => {});
  const taskQueue = vi.fn(() => ({ enqueue }));
  const getFunctions = vi.fn(() => ({ taskQueue }));
  return { enqueue, taskQueue, getFunctions };
});

vi.mock("../src/firebase", () => ({ db: { collection: fb.collection }, admin: {} }));
vi.mock("firebase-admin/functions", () => ({ getFunctions: fns.getFunctions }));

import { enqueueIngest } from "../src/tasks";
import { enqueueScan } from "../src/projectScan";

const ingestPayload = {
  userId: "u1",
  projectId: "p1",
  repoUrl: "https://github.com/acme/demo",
  ingestToken: "tok"
};
const scanPayload = {
  userId: "u1",
  projectId: "p1",
  scanId: "s1",
  repoUrl: "https://github.com/acme/demo",
  scanToken: "tok",
  options: {}
};

// Dispatch mode reads these env vars; control them deterministically so the
// suite behaves identically under `npm test` and `emulators:exec`.
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  vi.clearAllMocks();
  fb.snap.exists = false;
  savedEnv = {
    INGEST_INLINE: process.env.INGEST_INLINE,
    SCAN_INLINE: process.env.SCAN_INLINE,
    FUNCTIONS_EMULATOR: process.env.FUNCTIONS_EMULATOR,
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST
  };
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.INGEST_INLINE;
  delete process.env.SCAN_INLINE;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const flush = () => new Promise((r) => setImmediate(r));

describe("enqueueIngest (tasks.ts)", () => {
  it("noop mode records nothing and never touches the queue", async () => {
    process.env.INGEST_INLINE = "0";
    await enqueueIngest(ingestPayload);
    expect(fns.getFunctions).not.toHaveBeenCalled();
  });

  it("tasks mode enqueues onto the ingestWorker queue with a dispatch deadline", async () => {
    // No emulator + no override -> production "tasks" dispatch.
    await enqueueIngest(ingestPayload);
    expect(fns.getFunctions).toHaveBeenCalledTimes(1);
    expect(fns.taskQueue).toHaveBeenCalledWith("ingestWorker");
    expect(fns.enqueue).toHaveBeenCalledWith(ingestPayload, { dispatchDeadlineSeconds: 600 });
  });

  it("inline mode runs the job out-of-band (no queue), guarding ownership", async () => {
    process.env.INGEST_INLINE = "1";
    await enqueueIngest(ingestPayload);
    expect(fns.getFunctions).not.toHaveBeenCalled();
    await flush();
    // The inline job read the project doc (and bailed: not-owned/missing).
    expect(fb.collection).toHaveBeenCalledWith("projects");
  });
});

describe("enqueueScan (projectScan.ts)", () => {
  it("noop mode records nothing and never touches the queue", async () => {
    process.env.SCAN_INLINE = "0";
    await enqueueScan(scanPayload);
    expect(fns.getFunctions).not.toHaveBeenCalled();
  });

  it("tasks mode enqueues onto the scanWorker queue with a dispatch deadline", async () => {
    await enqueueScan(scanPayload);
    expect(fns.getFunctions).toHaveBeenCalledTimes(1);
    expect(fns.taskQueue).toHaveBeenCalledWith("scanWorker");
    expect(fns.enqueue).toHaveBeenCalledWith(scanPayload, { dispatchDeadlineSeconds: 600 });
  });

  it("inline mode runs the job out-of-band (no queue), guarding ownership", async () => {
    process.env.SCAN_INLINE = "1";
    await enqueueScan(scanPayload);
    expect(fns.getFunctions).not.toHaveBeenCalled();
    await flush();
    expect(fb.collection).toHaveBeenCalledWith("projects");
  });
});
