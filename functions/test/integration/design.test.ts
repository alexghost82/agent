/**
 * Integration tests — design router (GET /design, POST /design) against the
 * Firestore emulator. Auth, validation, listing/isolation, ownership (404) and
 * the `no_api_key` boundary for the generation path.
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: design router", () => {
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
    expectError(await srv.request("GET", "/design"), 401, "unauthorized");
    expectError(await srv.request("POST", "/design", { body: {} }), 401, "unauthorized");
  });

  it("lists only the caller's decisions and honours the projectId filter", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("project_decisions", { userId: a.userId, projectId: "p1", projectName: "A", decision: "x" });
    await addDoc("project_decisions", { userId: b.userId, projectId: "p1", projectName: "B", decision: "y" });

    const list = await srv.request("GET", "/design", { token: a.token });
    expect(list.status).toBe(200);
    expect(list.body.decisions.every((d: any) => d.userId === a.userId)).toBe(true);

    const filtered = await srv.request("GET", "/design?projectId=p1", { token: a.token });
    expect(filtered.body.decisions.every((d: any) => d.projectId === "p1" && d.userId === a.userId)).toBe(true);
  });

  it("rejects an invalid body (validation, 400)", async () => {
    const user = await seedUser();
    expectError(await srv.request("POST", "/design", { token: user.token, body: { projectId: "ab" } }), 400, "validation_failed");
  });

  it("returns 404 designing for a project the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: owner.userId, name: "Owned", description: "owned project" });
    expectError(await srv.request("POST", "/design", { token: other.token, body: { projectId } }), 404, "not_found");
  });

  it("surfaces no_api_key for an owned project with no AI key configured", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Owned",
      description: "owned project",
      skillIds: []
    });
    const res = await srv.request("POST", "/design", { token: user.token, body: { projectId } });
    expectError(res, 400, "no_api_key");
  });
});
