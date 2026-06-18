/**
 * Integration tests — plans router (GET /generated-plans, POST /generate-plan)
 * against the Firestore emulator. Auth, validation, listing/isolation, ownership
 * (404) and the `no_api_key` boundary for the generation path.
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: plans router", () => {
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
    expectError(await srv.request("GET", "/generated-plans"), 401, "unauthorized");
    expectError(await srv.request("POST", "/generate-plan", { body: {} }), 401, "unauthorized");
  });

  it("lists only the caller's plans and honours the projectId filter", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("generated_plans", { userId: a.userId, projectId: "p1", projectName: "A", files: [], prompts: [] });
    await addDoc("generated_plans", { userId: b.userId, projectId: "p1", projectName: "B", files: [], prompts: [] });

    const list = await srv.request("GET", "/generated-plans", { token: a.token });
    expect(list.status).toBe(200);
    expect(list.body.plans.every((p: any) => p.userId === a.userId)).toBe(true);

    const filtered = await srv.request("GET", "/generated-plans?projectId=p1", { token: a.token });
    expect(filtered.body.plans.every((p: any) => p.projectId === "p1" && p.userId === a.userId)).toBe(true);
  });

  it("rejects an invalid body (validation, 400)", async () => {
    const user = await seedUser();
    expectError(await srv.request("POST", "/generate-plan", { token: user.token, body: { projectId: "ab" } }), 400, "validation_failed");
  });

  it("returns 404 generating a plan for a project the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: owner.userId, name: "Owned", description: "owned project" });
    expectError(await srv.request("POST", "/generate-plan", { token: other.token, body: { projectId } }), 404, "not_found");
  });

  it("surfaces no_api_key for an owned project with no AI key configured", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Owned",
      description: "owned project",
      skillIds: []
    });
    const res = await srv.request("POST", "/generate-plan", { token: user.token, body: { projectId } });
    expectError(res, 400, "no_api_key");
  });
});
