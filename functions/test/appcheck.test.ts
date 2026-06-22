/**
 * Unit tests — Firebase App Check middleware (functions/src/auth.ts).
 *
 * No emulator and no real Firebase calls: `firebase-admin/app-check` is mocked so
 * `getAppCheck().verifyToken()` is a vitest spy we drive per-test. We cover the
 * off/warn/enforce modes against a present+valid, present+invalid and absent
 * token, the emulator bypass, and that routes mounted *before* the middleware
 * (the public routes) are exempt — exercised over a real ephemeral HTTP server.
 *
 * `./helpers/env` MUST be the first import so firebase-admin has a project id
 * before src/firebase.ts runs admin.initializeApp() at import time.
 */
import "./helpers/env";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

// Hoisted so the vi.mock factory can close over the same spy we assert on.
const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken })
}));

import { appCheck, appCheckMode } from "../src/auth";
import type { AuthedRequest } from "../src/auth";
import type { Response } from "express";

function mockReq(headers: Record<string, string | string[]> = {}): AuthedRequest {
  return { headers, requestId: "req-test", method: "GET", path: "/x" } as unknown as AuthedRequest;
}

interface MockRes extends Response {
  statusCode: number;
  body?: unknown;
}

function mockRes(): MockRes {
  const res = {} as MockRes;
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as MockRes["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as MockRes["json"];
  return res;
}

beforeEach(() => {
  verifyToken.mockReset();
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.APP_CHECK_ENFORCE;
});

afterEach(() => {
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.APP_CHECK_ENFORCE;
});

describe("appCheckMode", () => {
  it("defaults to warn and normalises unknown values", () => {
    expect(appCheckMode()).toBe("warn");
    process.env.APP_CHECK_ENFORCE = "bogus";
    expect(appCheckMode()).toBe("warn");
    process.env.APP_CHECK_ENFORCE = "ENFORCE";
    expect(appCheckMode()).toBe("enforce");
    process.env.APP_CHECK_ENFORCE = " Off ";
    expect(appCheckMode()).toBe("off");
  });
});

describe("appCheck middleware — off mode", () => {
  it("skips verification entirely even when a token is present", async () => {
    process.env.APP_CHECK_ENFORCE = "off";
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq({ "x-firebase-appcheck": "tok" }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(verifyToken).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("appCheck middleware — warn mode (default)", () => {
  it("allows a request with a valid token", async () => {
    verifyToken.mockResolvedValue({ appId: "app" });
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq({ "x-firebase-appcheck": "good" }), res, next);
    expect(verifyToken).toHaveBeenCalledWith("good");
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows but does not reject when the token is invalid", async () => {
    verifyToken.mockRejectedValue(new Error("invalid token"));
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq({ "x-firebase-appcheck": "bad" }), res, next);
    expect(verifyToken).toHaveBeenCalledWith("bad");
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows when no token is present and never calls verifyToken", async () => {
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq(), res, next);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("appCheck middleware — enforce mode", () => {
  it("allows a request with a valid token", async () => {
    process.env.APP_CHECK_ENFORCE = "enforce";
    verifyToken.mockResolvedValue({ appId: "app" });
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq({ "x-firebase-appcheck": "good" }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects an invalid token with a 403 forbidden envelope", async () => {
    process.env.APP_CHECK_ENFORCE = "enforce";
    verifyToken.mockRejectedValue(new Error("invalid token"));
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq({ "x-firebase-appcheck": "bad" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden", requestId: "req-test" });
  });

  it("rejects an absent token with a 403 forbidden envelope", async () => {
    process.env.APP_CHECK_ENFORCE = "enforce";
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq(), res, next);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden", requestId: "req-test" });
  });
});

describe("appCheck middleware — emulator bypass", () => {
  it("skips verification under the emulator regardless of mode", async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.APP_CHECK_ENFORCE = "enforce";
    const next = vi.fn();
    const res = mockRes();
    await appCheck(mockReq(), res, next);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// Exemption is a property of mount order: routes registered before the
// middleware never reach it. Verified over a real (ephemeral) HTTP server that
// mirrors index.ts wiring (public route -> appCheck -> protected route).
describe("appCheck middleware — public routes are exempt", () => {
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const app = express();
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
    app.use(appCheck);
    app.get("/secret", (_req, res) => {
      res.json({ secret: true });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("serves a public route without a token even in enforce mode, but gates the protected route", async () => {
    process.env.APP_CHECK_ENFORCE = "enforce";
    await withServer(async (port) => {
      const pub = await fetch(`http://127.0.0.1:${port}/health`);
      expect(pub.status).toBe(200);
      await expect(pub.json()).resolves.toEqual({ ok: true });
      expect(verifyToken).not.toHaveBeenCalled();

      const protectedNoToken = await fetch(`http://127.0.0.1:${port}/secret`);
      expect(protectedNoToken.status).toBe(403);
      await expect(protectedNoToken.json()).resolves.toMatchObject({ error: "forbidden" });

      verifyToken.mockResolvedValue({ appId: "app" });
      const protectedWithToken = await fetch(`http://127.0.0.1:${port}/secret`, {
        headers: { "X-Firebase-AppCheck": "good" }
      });
      expect(protectedWithToken.status).toBe(200);
      await expect(protectedWithToken.json()).resolves.toEqual({ secret: true });
      expect(verifyToken).toHaveBeenCalledWith("good");
    });
  });
});
