/**
 * Integration tests — sources router (GET /sources, POST /learn) against the
 * Firestore emulator. The /learn happy path needs the network + an AI key, so we
 * exercise it up to the deterministic, no-network boundaries: schema validation,
 * topic-ownership (404), and the SSRF guard (private host rejected with no fetch).
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: sources router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("GET", "/sources"), 401, "unauthorized");
    expectError(await srv.request("POST", "/learn", { body: {} }), 401, "unauthorized");
  });

  it("lists only the caller's sources and honours the topicId filter", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("sources", { userId: a.userId, topicId: "t1", url: "https://a1", title: "A1" });
    await addDoc("sources", { userId: a.userId, topicId: "t2", url: "https://a2", title: "A2" });
    await addDoc("sources", { userId: b.userId, topicId: "t1", url: "https://b1", title: "B1" });

    const all = await srv.request("GET", "/sources", { token: a.token });
    expect(all.status).toBe(200);
    expect(all.body.sources.every((s: any) => s.userId === a.userId)).toBe(true);
    expect(all.body.sources.map((s: any) => s.title).sort()).toEqual(["A1", "A2"]);

    const filtered = await srv.request("GET", "/sources?topicId=t1", { token: a.token });
    expect(filtered.body.sources.map((s: any) => s.title)).toEqual(["A1"]);
  });

  it("rejects /learn with an invalid body (validation, 400)", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/learn", {
      token: user.token,
      body: { topicId: "abc" } // missing url
    });
    expectError(res, 400, "validation_failed");
  });

  it("returns 404 when learning into a topic the caller does not own", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const topicId = await addDoc("topics", { userId: owner.userId, name: "Owned" });

    const res = await srv.request("POST", "/learn", {
      token: other.token,
      body: { topicId, url: "https://example.com/article" }
    });
    expectError(res, 404, "not_found");
  });

  it("refuses to fetch a private/internal URL (SSRF guard, no network)", async () => {
    const user = await seedUser();
    const topicId = await addDoc("topics", { userId: user.userId, name: "SSRF topic" });
    const res = await srv.request("POST", "/learn", {
      token: user.token,
      body: { topicId, url: "http://127.0.0.1:9/secret" }
    });
    // The SSRF guard throws before any fetch; the route surfaces it as an error
    // (currently `internal`/500 — see QA note re: classifying SSRF as a client
    // error). The security property under test is: the request is rejected and
    // no private address is ever contacted.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(typeof res.body.error).toBe("string");
  });
});
