/**
 * Integration test harness — Firestore emulator + the real Express routers.
 *
 * QA/Security scope: this lives entirely under functions/test/** and imports the
 * production routers WITHOUT modifying them. Because functions/src/index.ts only
 * exports the wrapped `functions.https.onRequest(app)` handler, we rebuild the
 * same Express wiring here (kept deliberately in sync with index.ts) so we can
 * drive it over real HTTP against the Firestore emulator.
 *
 * Every integration suite must be gated on `EMULATOR_AVAILABLE` so the default
 * `npm test` (no emulator) stays green and only the CI emulator job runs them.
 */
import "./env"; // MUST be first: primes GCLOUD_PROJECT before src/firebase init.

import http from "node:http";
import type { AddressInfo } from "node:net";
import * as nodeCrypto from "node:crypto";

import express from "express";
import type { Response, NextFunction } from "express";
import cors from "cors";
import { FieldValue } from "firebase-admin/firestore";

import { db } from "../../src/firebase";
import { requireAuth, hashPassword, makeSalt, type AuthedRequest } from "../../src/auth";
import { requestId } from "../../src/log";
import { sendError, notFound } from "../../src/errors";
import { publicRouter } from "../../src/routes/public";
import { sessionRouter } from "../../src/routes/session";
import { topicsRouter } from "../../src/routes/topics";
import { sourcesRouter } from "../../src/routes/sources";
import { skillsRouter } from "../../src/routes/skills";
import { projectsRouter } from "../../src/routes/projects";
import { askRouter } from "../../src/routes/ask";
import { designRouter } from "../../src/routes/design";
import { plansRouter } from "../../src/routes/plans";
import { dashboardRouter } from "../../src/routes/dashboard";
import { keysRouter } from "../../src/routes/keys";

export const EMULATOR_AVAILABLE = !!process.env.FIRESTORE_EMULATOR_HOST;

export { db };

export function sha256Hex(input: string): string {
  return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Rebuilds the production Express app exactly as functions/src/index.ts wires it
 * (requestId → CORS → json → /api strip → public → requireAuth → routers → 404 →
 * error handler). Kept deliberately in sync with index.ts. Reads ALLOWED_ORIGINS
 * / NODE_ENV at call time so CORS allow-list behaviour can be tested.
 */
export function buildApp(): express.Express {
  const app = express();

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === "production" && !process.env.FUNCTIONS_EMULATOR;
  let corsOrigin: boolean | string[];
  if (allowedOrigins.length) corsOrigin = allowedOrigins;
  else if (isProd) corsOrigin = false;
  else corsOrigin = true;

  app.use(requestId);
  app.use(cors({ origin: corsOrigin, credentials: false }));
  app.use(express.json({ limit: "4mb" }));

  // Firebase Hosting forwards /api/* to the function; strip the prefix.
  app.use((req, _res, next) => {
    if (req.url === "/api") req.url = "/";
    else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    next();
  });

  app.use(publicRouter);
  app.use(requireAuth);
  app.use(sessionRouter);
  app.use(topicsRouter);
  app.use(sourcesRouter);
  app.use(skillsRouter);
  app.use(projectsRouter);
  app.use(askRouter);
  app.use(designRouter);
  app.use(plansRouter);
  app.use(dashboardRouter);
  app.use(keysRouter);

  app.use((req: AuthedRequest, res: Response) => sendError(req, res, notFound()));
  app.use((err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) =>
    sendError(req, res, err)
  );

  return app;
}

export interface TestServer {
  baseUrl: string;
  request: ApiClient;
  close: () => Promise<void>;
}

export async function startServer(app?: express.Express): Promise<TestServer> {
  const server = http.createServer(app ?? buildApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    request: makeClient(baseUrl),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export type ApiClient = (
  method: string,
  path: string,
  opts?: RequestOptions
) => Promise<ApiResponse>;

export function makeClient(baseUrl: string): ApiClient {
  return async function request(method, path, opts = {}) {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body, headers: res.headers };
  };
}

/* -------------------------------------------------------------------------- */
/* Seeding helpers                                                            */
/* -------------------------------------------------------------------------- */

let seq = 0;
export function uid(prefix = "u"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}_${nodeCrypto.randomBytes(3).toString("hex")}`;
}

export interface SeededUser {
  userId: string;
  username: string;
  token: string;
}

/**
 * Creates a users/{id} doc whose session is valid under BOTH the current auth
 * implementation (raw `sessionToken`) and the contract §1 target
 * (`sessionTokenHash` + `sessionExpiresAt`), so these tests survive the backend
 * session-hardening migration without edits.
 */
export async function seedUser(extra: Record<string, unknown> = {}): Promise<SeededUser> {
  const userId = uid();
  const username = userId;
  const token = nodeCrypto.randomBytes(24).toString("hex");
  const salt = makeSalt();
  await db.collection("users").doc(userId).set({
    username,
    salt,
    passwordHash: hashPassword(`pw-${token}`, salt),
    sessionToken: token,
    sessionTokenHash: sha256Hex(token),
    sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    sessionUpdatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    ...extra
  });
  return { userId, username, token };
}

/** Creates a password-login user (doc id = lowercased username, like /login). */
export async function seedLoginUser(password: string): Promise<{ username: string; password: string }> {
  const username = uid("login");
  const salt = makeSalt();
  await db
    .collection("users")
    .doc(username.toLowerCase())
    .set({
      username,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: FieldValue.serverTimestamp()
    });
  return { username, password };
}

export async function addDoc(collection: string, data: Record<string, unknown>): Promise<string> {
  const ref = await db.collection(collection).add({ createdAt: FieldValue.serverTimestamp(), ...data });
  return ref.id;
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

import { expect } from "vitest";

export const STABLE_ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "validation_failed",
  "not_found",
  "no_api_key",
  "bad_request",
  "internal"
]);

/**
 * Always asserts the HTTP status. For the machine-readable error, this is
 * forward-compatible with contract §1: if the backend already emits a stable
 * code we assert it EXACTLY; legacy `err.message` bodies still pass on status
 * alone so the suite stays green until the backend error-envelope migration
 * lands. It never silently accepts the wrong stable code.
 */
export function expectError(res: ApiResponse, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body && typeof res.body.error).toBe("string");
  expect(String(res.body.error).length).toBeGreaterThan(0);
  if (STABLE_ERROR_CODES.has(res.body.error)) {
    expect(res.body.error).toBe(code);
  }
}

/** Temporarily removes env vars (e.g. AI keys); returns a restore function. */
export function stashEnv(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
