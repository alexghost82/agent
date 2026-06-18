/**
 * Integration tests — skills router (GET /skills, POST /skill, POST
 * /extract-skills) against the Firestore emulator. The LLM extraction path is
 * driven up to the deterministic no-network boundary via the `no_api_key` error.
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: skills router", () => {
  let srv: TestServer;
  let restoreEnv: () => void;
  beforeAll(async () => {
    // Force the AI layer to fail closed with `no_api_key` (no network calls).
    restoreEnv = stashEnv(["OPENAI_API_KEY", "GEMINI_API_KEY"]);
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
    restoreEnv();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("GET", "/skills"), 401, "unauthorized");
    expectError(await srv.request("POST", "/skill", { body: {} }), 401, "unauthorized");
    expectError(await srv.request("POST", "/extract-skills", { body: {} }), 401, "unauthorized");
  });

  it("creates a manual skill and lists it (scoped + topicId filter)", async () => {
    const user = await seedUser();
    const create = await srv.request("POST", "/skill", {
      token: user.token,
      body: { topicId: "topic-1", skillName: "Idempotency", description: "Safe retries everywhere." }
    });
    expect(create.status).toBe(200);
    expect(create.body.status).toBe("skill_saved");

    const list = await srv.request("GET", "/skills?topicId=topic-1", { token: user.token });
    expect(list.status).toBe(200);
    expect(list.body.skills.map((s: any) => s.skillName)).toContain("Idempotency");
  });

  it("isolates skills per user", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("agent_skills", { userId: a.userId, topicId: "t", skillName: "A-skill", description: "x" });
    await addDoc("agent_skills", { userId: b.userId, topicId: "t", skillName: "B-skill", description: "y" });

    const list = await srv.request("GET", "/skills", { token: a.token });
    const names = list.body.skills.map((s: any) => s.skillName);
    expect(names).toContain("A-skill");
    expect(names).not.toContain("B-skill");
  });

  it("rejects /skill and /extract-skills with invalid bodies (400)", async () => {
    const user = await seedUser();
    expectError(
      await srv.request("POST", "/skill", { token: user.token, body: { topicId: "ab" } }),
      400,
      "validation_failed"
    );
    expectError(
      await srv.request("POST", "/extract-skills", { token: user.token, body: {} }),
      400,
      "validation_failed"
    );
  });

  it("returns 404 extracting skills from a topic the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const topicId = await addDoc("topics", { userId: owner.userId, name: "Owned" });
    const res = await srv.request("POST", "/extract-skills", { token: other.token, body: { topicId } });
    expectError(res, 404, "not_found");
  });

  it("surfaces no_api_key when extracting from an owned topic without any AI key", async () => {
    const user = await seedUser();
    const topicId = await addDoc("topics", { userId: user.userId, name: "Owned topic" });
    const res = await srv.request("POST", "/extract-skills", { token: user.token, body: { topicId } });
    expectError(res, 400, "no_api_key");
  });
});
