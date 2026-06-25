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
  db,
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

  it("rejects unauthenticated PATCH/DELETE (401)", async () => {
    expectError(await srv.request("PATCH", "/skills/x", { body: { skillName: "n" } }), 401, "unauthorized");
    expectError(await srv.request("DELETE", "/skills/x"), 401, "unauthorized");
  });

  it("returns 404 patching/deleting a skill the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const skillId = await addDoc("agent_skills", {
      userId: owner.userId,
      topicId: "t",
      skillName: "Owned",
      description: "owned skill"
    });
    expectError(
      await srv.request("PATCH", `/skills/${skillId}`, { token: other.token, body: { skillName: "Hijack" } }),
      404,
      "not_found"
    );
    expectError(await srv.request("DELETE", `/skills/${skillId}`, { token: other.token }), 404, "not_found");
    // Untouched by the unauthorized calls.
    expect((await db.collection("agent_skills").doc(skillId).get()).data()?.skillName).toBe("Owned");
  });

  it("rejects an empty PATCH body (validation, 400)", async () => {
    const user = await seedUser();
    const skillId = await addDoc("agent_skills", {
      userId: user.userId,
      topicId: "t",
      skillName: "Editable",
      description: "before edit"
    });
    expectError(
      await srv.request("PATCH", `/skills/${skillId}`, { token: user.token, body: {} }),
      400,
      "validation_failed"
    );
  });

  it("updates an owned skill and recomputes quality", async () => {
    const user = await seedUser();
    const skillId = await addDoc("agent_skills", {
      userId: user.userId,
      topicId: "t",
      skillName: "Before",
      description: "old description",
      example: null,
      appliesTo: [],
      template: null,
      quality: { score: 0 }
    });
    const res = await srv.request("PATCH", `/skills/${skillId}`, {
      token: user.token,
      body: { skillName: "After", description: "a richer, more detailed description", example: "do X then Y" }
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("updated");

    const stored = (await db.collection("agent_skills").doc(skillId).get()).data()!;
    expect(stored.skillName).toBe("After");
    expect(stored.description).toBe("a richer, more detailed description");
    expect(stored.example).toBe("do X then Y");
    expect(typeof stored.quality?.score).toBe("number");
    expect(stored.updatedAt).toBeTruthy();
  });

  it("deletes an owned skill", async () => {
    const user = await seedUser();
    const skillId = await addDoc("agent_skills", {
      userId: user.userId,
      topicId: "t",
      skillName: "Disposable",
      description: "to be removed"
    });
    const res = await srv.request("DELETE", `/skills/${skillId}`, { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deleted");
    expect((await db.collection("agent_skills").doc(skillId).get()).exists).toBe(false);

    const list = await srv.request("GET", "/skills", { token: user.token });
    expect(list.body.skills.find((s: any) => s.id === skillId)).toBeUndefined();
  });
});
