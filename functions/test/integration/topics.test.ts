/**
 * Integration tests — topics router (GET /topics, POST /topics) against the
 * Firestore emulator. Covers auth (401), validation (400), creation, listing,
 * and strict per-user isolation.
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: topics router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access (401 unauthorized)", async () => {
    const res = await srv.request("GET", "/topics");
    expectError(res, 401, "unauthorized");
  });

  it("creates a topic and lists it back", async () => {
    const user = await seedUser();
    const create = await srv.request("POST", "/topics", {
      token: user.token,
      body: { name: "Distributed Systems", description: "consensus, CRDTs" }
    });
    expect(create.status).toBe(200);
    expect(create.body.status).toBe("created");
    expect(typeof create.body.id).toBe("string");

    const list = await srv.request("GET", "/topics", { token: user.token });
    expect(list.status).toBe(200);
    const names = list.body.topics.map((t: any) => t.name);
    expect(names).toContain("Distributed Systems");
  });

  it("rejects an invalid body (validation, 400)", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/topics", { token: user.token, body: { name: "x" } });
    expectError(res, 400, "validation_failed");
  });

  it("isolates topics per user — A never sees B's topics", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("topics", { userId: a.userId, name: "A-only topic" });
    await addDoc("topics", { userId: b.userId, name: "B-only topic" });

    const listA = await srv.request("GET", "/topics", { token: a.token });
    const namesA = listA.body.topics.map((t: any) => t.name);
    expect(namesA).toContain("A-only topic");
    expect(namesA).not.toContain("B-only topic");
    expect(listA.body.topics.every((t: any) => t.userId === a.userId)).toBe(true);
  });
});
