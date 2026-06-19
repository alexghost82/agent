/**
 * Integration tests — memory inspection/deletion (CONTRACT v3.6) against the
 * Firestore emulator. Seeds knowledge_chunks directly (no LLM/network) and
 * asserts auth, per-user isolation, embedding redaction, and owner-scoped delete.
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: memory router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("GET", "/memory"), 401, "unauthorized");
    expectError(await srv.request("DELETE", "/memory/x"), 401, "unauthorized");
  });

  it("lists only the caller's chunks and never returns the embedding", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addDoc("knowledge_chunks", {
      userId: a.userId, scope: "topic", topicId: "t1", title: "A doc",
      sourceUrl: "https://a.example/1", content: "alpha content", chunkType: "fact",
      embedding: [0.1, 0.2, 0.3], contentHash: "h1"
    });
    await addDoc("knowledge_chunks", {
      userId: b.userId, scope: "topic", topicId: "t1", title: "B doc",
      content: "beta content", chunkType: "fact", embedding: [0.4], contentHash: "h2"
    });

    const res = await srv.request("GET", "/memory", { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.chunks.length).toBe(1);
    expect(res.body.chunks[0].title).toBe("A doc");
    expect(res.body.chunks[0].preview).toContain("alpha");
    expect("embedding" in res.body.chunks[0]).toBe(false);
  });

  it("deletes only an owned chunk (404 otherwise)", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const chunkId = await addDoc("knowledge_chunks", {
      userId: a.userId, scope: "topic", title: "del me", content: "x", embedding: [0.1], contentHash: "h3"
    });
    // B cannot delete A's chunk.
    expectError(await srv.request("DELETE", `/memory/${chunkId}`, { token: b.token }), 404, "not_found");
    // A can.
    const ok = await srv.request("DELETE", `/memory/${chunkId}`, { token: a.token });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("deleted");
    // Gone now.
    expectError(await srv.request("DELETE", `/memory/${chunkId}`, { token: a.token }), 404, "not_found");
  });

  it("honours the topicId filter", async () => {
    const a = await seedUser();
    await addDoc("knowledge_chunks", { userId: a.userId, scope: "topic", topicId: "tx", title: "x", content: "x", embedding: [0.1], contentHash: "hx" });
    await addDoc("knowledge_chunks", { userId: a.userId, scope: "topic", topicId: "ty", title: "y", content: "y", embedding: [0.1], contentHash: "hy" });
    const res = await srv.request("GET", "/memory?topicId=tx", { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.chunks.every((c: any) => c.topicId === "tx")).toBe(true);
  });
});
