/**
 * Integration tests — ask router (POST /ask) against the Firestore emulator.
 * Auth + validation run before any AI call; the RAG path is exercised up to the
 * `no_api_key` boundary (memory + ai.resolve) without hitting the network.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  expectError,
  stashEnv,
  type TestServer
} from "../helpers/harness";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: ask router", () => {
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
    expectError(await srv.request("POST", "/ask", { body: { question: "hello there" } }), 401, "unauthorized");
  });

  it("rejects an invalid body (validation, 400)", async () => {
    const user = await seedUser();
    expectError(await srv.request("POST", "/ask", { token: user.token, body: { question: "hi" } }), 400, "validation_failed");
  });

  it("surfaces no_api_key for a valid question with no AI key configured", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/ask", {
      token: user.token,
      body: { question: "What is the system architecture?" }
    });
    expectError(res, 400, "no_api_key");
  });
});
