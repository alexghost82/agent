/**
 * Integration tests — dashboard router (GET /dashboard) against the Firestore
 * emulator. Verifies the aggregate counts + recent logs are strictly scoped to
 * the caller (another user's documents must not leak into the totals).
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: dashboard router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("GET", "/dashboard"), 401, "unauthorized");
  });

  it("returns counts and recent logs scoped to the caller only", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("topics", { userId: a.userId, name: "A1" });
    await addDoc("topics", { userId: a.userId, name: "A2" });
    await addDoc("topics", { userId: b.userId, name: "B1" });
    await addDoc("projects", { userId: a.userId, name: "A proj", description: "alpha" });
    await addDoc("agent_logs", { userId: a.userId, type: "ask", message: "A asked" });
    await addDoc("agent_logs", { userId: b.userId, type: "ask", message: "B asked" });

    const res = await srv.request("GET", "/dashboard", { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.counts.topics).toBe(2);
    expect(res.body.counts.projects).toBe(1);
    expect(Array.isArray(res.body.recentLogs)).toBe(true);
    expect(res.body.recentLogs.every((l: any) => l.userId === a.userId)).toBe(true);
    expect(res.body.recentLogs.some((l: any) => l.message === "B asked")).toBe(false);
  });
});
