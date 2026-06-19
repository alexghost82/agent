/**
 * Integration tests — async repo ingestion (ADR-0002 / A2). Verifies that
 * `connect-github` only ENQUEUES (fast 202 + `queued` state) and that the
 * Cloud Tasks job (`runIngestJob`) is idempotent / supersession-safe.
 *
 * Gated on the Firestore emulator like every other integration suite. The
 * ingest function itself is injected with a fake so no network/GitHub is hit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  addDoc,
  db,
  type TestServer
} from "../helpers/harness";
import { runIngestJob, type IngestPayload } from "../../src/tasks";
import type { IngestResult } from "../../src/github";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: async ingest", () => {
  let srv: TestServer;
  let prevInline: string | undefined;

  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  // For the route test we want to assert the enqueue WITHOUT running the job or
  // needing a Cloud Tasks emulator: INGEST_INLINE=0 makes enqueue a no-op.
  beforeEach(() => {
    prevInline = process.env.INGEST_INLINE;
    process.env.INGEST_INLINE = "0";
  });
  afterEach(() => {
    if (prevInline === undefined) delete process.env.INGEST_INLINE;
    else process.env.INGEST_INLINE = prevInline;
  });

  it("connect-github enqueues and returns 202 queued (no synchronous ingest)", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Repo proj",
      description: "needs ingestion",
      ingestStatus: "none"
    });

    const res = await srv.request("POST", `/projects/${projectId}/connect-github`, {
      token: user.token,
      body: { repoUrl: "https://github.com/acme/widget" }
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.projectId).toBe(projectId);

    const doc = await db.collection("projects").doc(projectId).get();
    const data = doc.data()!;
    expect(data.ingestStatus).toBe("queued");
    expect(typeof data.ingestToken).toBe("string");
    expect(data.ingestToken.length).toBeGreaterThan(0);
    expect(data.repoUrl).toBe("https://github.com/acme/widget");
    expect(data.ingestError).toBeNull();
  });

  it("runIngestJob finalizes to ready and records the result", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Job proj",
      description: "p",
      ingestStatus: "queued",
      ingestToken: "tok-1"
    });

    let calls = 0;
    const fakeIngest = async (): Promise<IngestResult> => {
      calls += 1;
      return { branch: "main", filesIndexed: 3, chunks: 7, summary: "ok" };
    };

    const payload: IngestPayload = { userId: user.userId, projectId, repoUrl: "https://github.com/acme/widget", ingestToken: "tok-1" };
    await runIngestJob(payload, fakeIngest as never);

    expect(calls).toBe(1);
    const data = (await db.collection("projects").doc(projectId).get()).data()!;
    expect(data.ingestStatus).toBe("ready");
    expect(data.ingestedFiles).toBe(3);
    expect(data.ingestedChunks).toBe(7);
    expect(data.defaultBranch).toBe("main");
  });

  it("drops a superseded (stale token) job without running ingest", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Stale proj",
      description: "p",
      ingestStatus: "queued",
      ingestToken: "tok-NEW"
    });

    let calls = 0;
    const fakeIngest = async (): Promise<IngestResult> => {
      calls += 1;
      return { branch: "main", filesIndexed: 1, chunks: 1, summary: "x" };
    };

    // A stale/retried task still carries the OLD token.
    await runIngestJob(
      { userId: user.userId, projectId, repoUrl: "https://github.com/acme/widget", ingestToken: "tok-OLD" },
      fakeIngest as never
    );

    expect(calls).toBe(0); // never ran
    const data = (await db.collection("projects").doc(projectId).get()).data()!;
    expect(data.ingestStatus).toBe("queued"); // left untouched
  });

  it("ignores a job for a project the user does not own (orphaned)", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", {
      userId: owner.userId,
      name: "Owned",
      description: "p",
      ingestStatus: "queued",
      ingestToken: "t"
    });

    let calls = 0;
    const fakeIngest = async (): Promise<IngestResult> => {
      calls += 1;
      return { branch: "main", filesIndexed: 0, chunks: 0, summary: "" };
    };

    await runIngestJob(
      { userId: other.userId, projectId, repoUrl: "https://github.com/acme/widget", ingestToken: "t" },
      fakeIngest as never
    );

    expect(calls).toBe(0);
    const data = (await db.collection("projects").doc(projectId).get()).data()!;
    expect(data.ingestStatus).toBe("queued");
  });

  it("re-running the same token is idempotent (no error, finalizes again)", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Idem proj",
      description: "p",
      ingestStatus: "queued",
      ingestToken: "tok-1"
    });

    const fakeIngest = async (): Promise<IngestResult> => ({ branch: "main", filesIndexed: 2, chunks: 4, summary: "ok" });
    const payload: IngestPayload = { userId: user.userId, projectId, repoUrl: "https://github.com/acme/widget", ingestToken: "tok-1" };

    await runIngestJob(payload, fakeIngest as never);
    await runIngestJob(payload, fakeIngest as never); // retry / duplicate delivery

    const data = (await db.collection("projects").doc(projectId).get()).data()!;
    expect(data.ingestStatus).toBe("ready");
    expect(data.ingestedChunks).toBe(4);
  });
});
