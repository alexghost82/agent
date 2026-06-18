/**
 * Integration tests — public router (GET /health, POST /login) plus the /api
 * prefix-strip middleware, against the Firestore emulator. Login is exercised
 * end to end: bad credentials (401), validation (400), and a successful login
 * whose issued token then authorises a protected route.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedLoginUser,
  expectError,
  type TestServer
} from "../helpers/harness";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: public router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("GET /health is liveness and needs no auth", async () => {
    const res = await srv.request("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe("string");
  });

  it("strips the /api prefix (Hosting rewrite parity)", async () => {
    const res = await srv.request("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects /login with a missing field (validation, 400)", async () => {
    const res = await srv.request("POST", "/login", { body: { username: "someone" } });
    expectError(res, 400, "validation_failed");
  });

  it("rejects /login with wrong credentials (401)", async () => {
    const { username } = await seedLoginUser("correct-horse");
    const res = await srv.request("POST", "/login", { body: { username, password: "wrong" } });
    expect(res.status).toBe(401);
  });

  it("logs in with valid credentials and issues a usable session token", async () => {
    const { username, password } = await seedLoginUser("correct-horse");
    const login = await srv.request("POST", "/login", { body: { username, password } });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(typeof login.body.token).toBe("string");
    expect(login.body.user.username).toBe(username);

    const authed = await srv.request("GET", "/topics", { token: login.body.token });
    expect(authed.status).toBe(200);
  });
});
