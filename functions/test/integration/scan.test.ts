/**
 * Integration tests — project-intelligence scan lifecycle. Mirrors ingest.test.ts:
 * the `/projects/:id/scan` route only ENQUEUES (fast 202), and `runScanJob` is
 * idempotent / supersession-safe. The network scan is injected as a fake so no
 * GitHub call is made. Gated on the Firestore emulator.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  addDoc,
  db,
  expectError,
  type TestServer
} from "../helpers/harness";
import { runScanJob, type ScanPayload } from "../../src/projectScan";
import type { ScanResult } from "../../src/project-intelligence/types";

const fakeScanResult = (): ScanResult => ({
  branch: "main",
  truncated: false,
  totalTreeFiles: 2,
  files: [
    {
      path: "src/routes/users.ts",
      size: 60,
      language: "typescript",
      role: "route",
      content: "import { svc } from '../services/userService';\nexport const GET = () => svc();"
    },
    {
      path: "src/services/userService.ts",
      size: 40,
      language: "typescript",
      role: "service",
      content: "export const svc = () => 1;"
    }
  ]
});

describe.skipIf(!EMULATOR_AVAILABLE)("integration: project scan", () => {
  let srv: TestServer;
  let prevInline: string | undefined;

  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  // Route tests assert the enqueue WITHOUT running the job: SCAN_INLINE=0 no-ops.
  beforeEach(() => {
    prevInline = process.env.SCAN_INLINE;
    process.env.SCAN_INLINE = "0";
  });
  afterEach(() => {
    if (prevInline === undefined) delete process.env.SCAN_INLINE;
    else process.env.SCAN_INLINE = prevInline;
  });

  it("POST /scan enqueues, returns 202 queued and creates a pending scan doc", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Scan proj",
      description: "p",
      repoUrl: "https://github.com/acme/widget"
    });

    const res = await srv.request("POST", `/projects/${projectId}/scan`, { token: user.token, body: { ai: false } });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(typeof res.body.scanId).toBe("string");

    const proj = (await db.collection("projects").doc(projectId).get()).data()!;
    expect(proj.scanStatus).toBe("queued");
    expect(typeof proj.scanToken).toBe("string");

    const scan = (await db.collection("project_scans").doc(res.body.scanId).get()).data()!;
    expect(scan.status).toBe("pending");
    expect(scan.projectId).toBe(projectId);
  });

  it("POST /scan without a connected repo is rejected", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "No repo", description: "p" });
    const res = await srv.request("POST", `/projects/${projectId}/scan`, { token: user.token });
    expectError(res, 400, "bad_request");
  });

  it("runScanJob completes the scan and persists the map + nodes", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Job proj",
      description: "p",
      repoUrl: "https://github.com/acme/widget",
      scanToken: "tok-1"
    });
    const scanId = await addDoc("project_scans", {
      userId: user.userId,
      projectId,
      status: "pending",
      scanToken: "tok-1"
    });

    let calls = 0;
    const fakeScan = async () => {
      calls += 1;
      return fakeScanResult();
    };
    const payload: ScanPayload = {
      userId: user.userId,
      projectId,
      scanId,
      repoUrl: "https://github.com/acme/widget",
      scanToken: "tok-1",
      options: { ai: false }
    };
    await runScanJob(payload, { scan: fakeScan as never });

    expect(calls).toBe(1);
    const scan = (await db.collection("project_scans").doc(scanId).get()).data()!;
    expect(scan.status).toBe("completed");

    const proj = (await db.collection("projects").doc(projectId).get()).data()!;
    expect(proj.scanStatus).toBe("completed");
    expect(proj.lastScanId).toBe(scanId);

    const map = (await db.collection("project_maps").doc(scanId).get()).data()!;
    expect(Array.isArray(map.nodes)).toBe(true);
    expect(map.nodes.length).toBeGreaterThan(0);

    const nodes = await db.collection("project_nodes").where("scanId", "==", scanId).limit(1).get();
    expect(nodes.empty).toBe(false);
  });

  it("drops a superseded (stale token) scan without running it", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Stale",
      description: "p",
      repoUrl: "https://github.com/acme/widget",
      scanToken: "tok-NEW"
    });
    const scanId = await addDoc("project_scans", { userId: user.userId, projectId, status: "pending", scanToken: "tok-OLD" });

    let calls = 0;
    const fakeScan = async () => {
      calls += 1;
      return fakeScanResult();
    };
    await runScanJob(
      { userId: user.userId, projectId, scanId, repoUrl: "https://github.com/acme/widget", scanToken: "tok-OLD", options: {} },
      { scan: fakeScan as never }
    );

    expect(calls).toBe(0);
    const scan = (await db.collection("project_scans").doc(scanId).get()).data()!;
    expect(scan.status).toBe("failed");
  });

  it("ignores a scan for a project the user does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", {
      userId: owner.userId,
      name: "Owned",
      description: "p",
      repoUrl: "https://github.com/acme/widget",
      scanToken: "t"
    });
    const scanId = await addDoc("project_scans", { userId: other.userId, projectId, status: "pending", scanToken: "t" });

    let calls = 0;
    const fakeScan = async () => {
      calls += 1;
      return fakeScanResult();
    };
    await runScanJob(
      { userId: other.userId, projectId, scanId, repoUrl: "https://github.com/acme/widget", scanToken: "t", options: {} },
      { scan: fakeScan as never }
    );
    expect(calls).toBe(0);
  });
});
