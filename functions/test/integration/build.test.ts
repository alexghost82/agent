/**
 * Integration tests — build router (CONTRACT v2.2) against the Firestore
 * emulator. Covers auth, validation, ownership (404, incl. cross-tenant plan),
 * the `no_api_key` boundary for the generation path, and listing isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  addDoc,
  expectError,
  stashEnv,
  type TestServer
} from "../helpers/harness";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: build router", () => {
  let srv: TestServer;
  let restoreEnv: () => void;
  beforeAll(async () => {
    restoreEnv = stashEnv(["OPENAI_API_KEY", "GEMINI_API_KEY"]);
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
    restoreEnv();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("GET", "/builds"), 401, "unauthorized");
    expectError(await srv.request("GET", "/builds/x"), 401, "unauthorized");
    expectError(await srv.request("POST", "/projects/p/build", { body: {} }), 401, "unauthorized");
  });

  it("rejects an invalid body (validation, 400)", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "P", description: "desc", skillIds: [] });
    expectError(
      await srv.request("POST", `/projects/${projectId}/build`, { token: user.token, body: { planId: "ab" } }),
      400,
      "validation_failed"
    );
  });

  it("returns 404 building a project the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: owner.userId, name: "Owned", description: "owned", skillIds: [] });
    expectError(
      await srv.request("POST", `/projects/${projectId}/build`, { token: other.token, body: {} }),
      404,
      "not_found"
    );
  });

  it("returns 404 when the referenced plan is not owned by the caller", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Owned", description: "owned", skillIds: [] });
    const foreignPlan = await addDoc("generated_plans", { userId: other.userId, projectId: "x", projectName: "X", files: [], prompts: [] });
    expectError(
      await srv.request("POST", `/projects/${projectId}/build`, { token: user.token, body: { planId: foreignPlan } }),
      404,
      "not_found"
    );
  });

  it("surfaces no_api_key for an owned project with no AI key configured", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Owned", description: "owned", skillIds: [] });
    const res = await srv.request("POST", `/projects/${projectId}/build`, { token: user.token, body: {} });
    expectError(res, 400, "no_api_key");
    // The run should be recorded as errored (observability), still owned by the caller.
    const list = await srv.request("GET", `/builds?projectId=${projectId}`, { token: user.token });
    expect(list.status).toBe(200);
    expect(list.body.runs.length).toBe(1);
    expect(list.body.runs[0].status).toBe("error");
    expect(list.body.runs[0].userId).toBe(user.userId);
  });

  it("lists only the caller's build runs and isolates a single run + artifacts", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const runA = await addDoc("build_runs", { userId: a.userId, projectId: "p1", projectName: "A", status: "ready", fileCount: 1 });
    await addDoc("build_runs", { userId: b.userId, projectId: "p1", projectName: "B", status: "ready", fileCount: 1 });
    await addDoc("build_artifacts", { userId: a.userId, buildRunId: runA, projectId: "p1", path: "src/a.ts", content: "x", language: "typescript", bytes: 1 });
    await addDoc("build_artifacts", { userId: b.userId, buildRunId: runA, projectId: "p1", path: "leak.ts", content: "y", language: "typescript", bytes: 1 });

    const list = await srv.request("GET", "/builds", { token: a.token });
    expect(list.status).toBe(200);
    expect(list.body.runs.every((r: any) => r.userId === a.userId)).toBe(true);

    const one = await srv.request("GET", `/builds/${runA}`, { token: a.token });
    expect(one.status).toBe(200);
    expect(one.body.run.id).toBe(runA);
    // Cross-tenant artifact under the same buildRunId must NOT leak.
    expect(one.body.artifacts.every((f: any) => f.userId === a.userId)).toBe(true);
    expect(one.body.artifacts.map((f: any) => f.path)).toEqual(["src/a.ts"]);

    // B cannot read A's run.
    expectError(await srv.request("GET", `/builds/${runA}`, { token: b.token }), 404, "not_found");
  });
});
