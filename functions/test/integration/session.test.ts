/**
 * Integration tests — change-password (CONTRACT v3 / SECURITY) against the
 * Firestore emulator. seedUser stores passwordHash for `pw-<token>`, so we can
 * exercise the real verify → rotate → session-invalidation flow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  expectError,
  type TestServer
} from "../helpers/harness";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: change-password", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated (401) and validates the new password length (400)", async () => {
    expectError(await srv.request("POST", "/change-password", { body: {} }), 401, "unauthorized");
    const u = await seedUser();
    expectError(
      await srv.request("POST", "/change-password", { token: u.token, body: { currentPassword: `pw-${u.token}`, newPassword: "short" } }),
      400,
      "validation_failed"
    );
  });

  it("rejects a wrong current password (401)", async () => {
    const u = await seedUser();
    expectError(
      await srv.request("POST", "/change-password", { token: u.token, body: { currentPassword: "wrong-password", newPassword: "a-strong-new-password" } }),
      401,
      "unauthorized"
    );
  });

  it("changes the password and invalidates the existing session", async () => {
    const u = await seedUser();
    const ok = await srv.request("POST", "/change-password", {
      token: u.token,
      body: { currentPassword: `pw-${u.token}`, newPassword: "a-strong-new-password" }
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("password_changed");
    // Session was invalidated → the old bearer no longer authenticates.
    expectError(await srv.request("GET", "/dashboard", { token: u.token }), 401, "unauthorized");
  });
});
