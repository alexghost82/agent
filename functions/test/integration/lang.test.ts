/**
 * Integration tests — reply-language (`lang`) support on the agent endpoints.
 *
 * Confirms the new optional `lang` field is accepted (request passes validation
 * and proceeds up to the `no_api_key` boundary, exactly like a request without
 * `lang`) and that an out-of-range value is rejected by validation. This guards
 * the backward-compatible contract: omitting `lang` must keep working, and only
 * the three supported languages are allowed.
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

describe.skipIf(!EMULATOR_AVAILABLE)("integration: reply-language (lang)", () => {
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

  for (const lang of ["en", "he", "ru"] as const) {
    it(`accepts lang="${lang}" on /ask (reaches no_api_key)`, async () => {
      const user = await seedUser();
      const res = await srv.request("POST", "/ask", {
        token: user.token,
        body: { question: "What is the system architecture?", lang }
      });
      expectError(res, 400, "no_api_key");
    });
  }

  it("still works when lang is omitted (backward compatible)", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/ask", {
      token: user.token,
      body: { question: "What is the system architecture?" }
    });
    expectError(res, 400, "no_api_key");
  });

  it("rejects an unsupported lang value (validation, 400)", async () => {
    const user = await seedUser();
    const res = await srv.request("POST", "/ask", {
      token: user.token,
      body: { question: "What is the system architecture?", lang: "fr" }
    });
    expectError(res, 400, "validation_failed");
  });
});
