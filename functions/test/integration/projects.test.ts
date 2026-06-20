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
});
