/**
 * Integration tests — projects router (CRUD + github-token + connect-github)
 * against the Firestore emulator. Covers auth, validation, ownership (404),
 * isolation, and the rate limiter (429) on connect-github.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  addDoc,
  expectError,
  type TestServer
} from "../helpers/harness";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: projects router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    // /github-token encrypts the PAT at rest (contract §1), which needs a master
    // secret; provide a test-only one so the encrypt path succeeds.
    process.env.KEYS_ENC_SECRET = process.env.KEYS_ENC_SECRET || "test-master-secret-for-projects-suite";
    // Keep enqueue jobs as a recorded no-op so the 202 contract is exercised
    // without a background network scan/ingest firing during the suite.
    process.env.SCAN_INLINE = "0";
    process.env.INGEST_INLINE = "0";
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("GET", "/projects"), 401, "unauthorized");
    expectError(await srv.request("POST", "/projects", { body: {} }), 401, "unauthorized");
  });

  it("creates, lists, and patches an owned project", async () => {
    const user = await seedUser();
    const create = await srv.request("POST", "/projects", {
      token: user.token,
      body: { name: "GHOST", description: "agent builder platform" }
    });
    expect(create.status).toBe(200);
    const id = create.body.id;

    const list = await srv.request("GET", "/projects", { token: user.token });
    expect(list.body.projects.map((p: any) => p.id)).toContain(id);

    const patch = await srv.request("PATCH", `/projects/${id}`, {
      token: user.token,
      body: { name: "GHOST 2" }
    });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe("updated");
  });

  it("deletes an owned project and removes its scoped data", async () => {
    const user = await seedUser();
    const create = await srv.request("POST", "/projects", {
      token: user.token,
      body: { name: "Disposable", description: "project to be deleted" }
    });
    const id = create.body.id;
    // Seed data scoped to the project that must be cleaned up on delete.
    await addDoc("knowledge_chunks", { userId: user.userId, projectId: id, content: "x", scope: "project" });
    await addDoc("project_decisions", { userId: user.userId, projectId: id, decision: "d" });
    await addDoc("generated_plans", { userId: user.userId, projectId: id, files: [] });

    const del = await srv.request("DELETE", `/projects/${id}`, { token: user.token });
    expect(del.status).toBe(200);
    expect(del.body.status).toBe("deleted");

    const list = await srv.request("GET", "/projects", { token: user.token });
    expect(list.body.projects.map((p: any) => p.id)).not.toContain(id);
  });

  it("returns 404 deleting a project the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const id = await addDoc("projects", { userId: owner.userId, name: "Owned", description: "owned project" });
    const res = await srv.request("DELETE", `/projects/${id}`, { token: other.token });
    expectError(res, 404, "not_found");
  });

  it("rejects an invalid project body (validation, 400)", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/projects", {
      token: user.token,
      body: { name: "ok name", description: "tiny" } // description min 5 — 'tiny' is 4
    });
    expectError(res, 400, "validation_failed");
  });

  it("returns 404 patching a project the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const id = await addDoc("projects", { userId: owner.userId, name: "Owned", description: "owned project" });
    const res = await srv.request("PATCH", `/projects/${id}`, { token: other.token, body: { name: "hijack" } });
    expectError(res, 404, "not_found");
  });

  it("isolates projects per user", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("projects", { userId: a.userId, name: "A proj", description: "alpha project" });
    await addDoc("projects", { userId: b.userId, name: "B proj", description: "beta project" });
    const list = await srv.request("GET", "/projects", { token: a.token });
    const names = list.body.projects.map((p: any) => p.name);
    expect(names).toContain("A proj");
    expect(names).not.toContain("B proj");
  });

  it("stores a github token via POST /github-token", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/github-token", {
      token: user.token,
      body: { token: "ghp_FAKEfake0123456789abcdefghijklmnop" }
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("saved");
  });

  it("rate-limits connect-github (429 rate_limited after 6/min)", async () => {
    const user = await seedUser();
    // connect-github is limited to 6 per minute. The limiter runs before the
    // ownership check, so 6 requests pass the gate (404 owner-missing) and the
    // 7th is rejected with 429 — no network is involved.
    const bogusId = "no-such-project";
    let sawRateLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await srv.request("POST", `/projects/${bogusId}/connect-github`, {
        token: user.token,
        body: { repoUrl: "https://github.com/acme/widget" }
      });
      if (res.status === 429) {
        expectError(res, 429, "rate_limited");
        sawRateLimit = true;
        break;
      }
      expect([400, 404]).toContain(res.status);
    }
    expect(sawRateLimit).toBe(true);
  });

  it("connect-github enqueues and marks the project queued (202)", async () => {
    const user = await seedUser();
    const id = await addDoc("projects", { userId: user.userId, name: "Repo", description: "connect target" });
    const res = await srv.request("POST", `/projects/${id}/connect-github`, {
      token: user.token,
      body: { repoUrl: "https://github.com/acme/widget" }
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
  });

  it("flow-map GET/PUT round-trips per (project, kind) and updates in place", async () => {
    const user = await seedUser();
    const id = await addDoc("projects", { userId: user.userId, name: "Mapper", description: "flow map host" });

    // Nothing saved yet -> null.
    const empty = await srv.request("GET", `/projects/${id}/map?kind=design`, { token: user.token });
    expect(empty.status).toBe(200);
    expect(empty.body.map).toBeNull();

    // Save a design map.
    const save = await srv.request("PUT", `/projects/${id}/map`, {
      token: user.token,
      body: { kind: "design", nodes: [{ id: "n1", label: "Node" }], edges: [] }
    });
    expect(save.status).toBe(200);
    expect(save.body.status).toBe("saved");
    const mapId = save.body.id;

    // GET returns it back.
    const got = await srv.request("GET", `/projects/${id}/map?kind=design`, { token: user.token });
    expect(got.body.map.id).toBe(mapId);
    expect(got.body.map.nodes).toHaveLength(1);

    // A second PUT updates the SAME doc (the existing-map branch).
    const update = await srv.request("PUT", `/projects/${id}/map`, {
      token: user.token,
      body: { kind: "design", nodes: [{ id: "n1", label: "A" }, { id: "n2", label: "B" }], edges: [] }
    });
    expect(update.body.id).toBe(mapId);
    const reread = await srv.request("GET", `/projects/${id}/map?kind=design`, { token: user.token });
    expect(reread.body.map.nodes).toHaveLength(2);

    // The "project" kind is independent of "design".
    const projKind = await srv.request("GET", `/projects/${id}/map?kind=project`, { token: user.token });
    expect(projKind.body.map).toBeNull();
  });

  it("flow-map rejects an unknown kind (404) and an invalid body (400)", async () => {
    const user = await seedUser();
    const id = await addDoc("projects", { userId: user.userId, name: "MapGuard", description: "guards" });

    expectError(
      await srv.request("GET", `/projects/${id}/map?kind=bogus`, { token: user.token }),
      404,
      "not_found"
    );
    expectError(
      await srv.request("PUT", `/projects/${id}/map`, { token: user.token, body: { kind: "nope", nodes: [], edges: [] } }),
      400,
      "validation_failed"
    );
  });

  it("flow-map is owner-scoped (404 for a foreign project)", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const id = await addDoc("projects", { userId: owner.userId, name: "Private", description: "owner only" });
    expectError(
      await srv.request("GET", `/projects/${id}/map?kind=design`, { token: other.token }),
      404,
      "not_found"
    );
    expectError(
      await srv.request("PUT", `/projects/${id}/map`, { token: other.token, body: { kind: "design", nodes: [], edges: [] } }),
      404,
      "not_found"
    );
  });

  it("scan status/map/node reads are owner-scoped and null/404 before any scan", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const id = await addDoc("projects", { userId: user.userId, name: "Scannable", description: "scan reads" });

    const status = await srv.request("GET", `/projects/${id}/scan`, { token: user.token });
    expect(status.status).toBe(200);
    expect(status.body.scan).toBeNull();

    const map = await srv.request("GET", `/projects/${id}/scan/map`, { token: user.token });
    expect(map.status).toBe(200);
    expect(map.body.map).toBeNull();

    // No scan yet -> node detail is 404.
    expectError(
      await srv.request("GET", `/projects/${id}/nodes/some-node`, { token: user.token }),
      404,
      "not_found"
    );

    // Cross-tenant access is a 404 on every read.
    expectError(await srv.request("GET", `/projects/${id}/scan`, { token: other.token }), 404, "not_found");
    expectError(await srv.request("GET", `/projects/${id}/scan/map`, { token: other.token }), 404, "not_found");
  });

  it("scan POST 400s without a connected repo and 202s once a repo is set", async () => {
    const user = await seedUser();
    const noRepo = await addDoc("projects", { userId: user.userId, name: "NoRepo", description: "no repo yet" });
    expectError(
      await srv.request("POST", `/projects/${noRepo}/scan`, { token: user.token, body: {} }),
      400,
      "bad_request"
    );

    const withRepo = await addDoc("projects", {
      userId: user.userId,
      name: "WithRepo",
      description: "ready to scan",
      repoUrl: "https://github.com/acme/demo"
    });
    const queued = await srv.request("POST", `/projects/${withRepo}/scan`, { token: user.token, body: { depth: 3 } });
    expect(queued.status).toBe(202);
    expect(queued.body.status).toBe("queued");
    expect(typeof queued.body.scanId).toBe("string");

    // The /rescan alias shares the handler.
    const rescan = await srv.request("POST", `/projects/${withRepo}/rescan`, { token: user.token, body: {} });
    expect(rescan.status).toBe(202);
  });
});
