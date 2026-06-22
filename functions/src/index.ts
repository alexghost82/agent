import { onRequest } from "firebase-functions/v2/https";
import express from "express";
import type { Response, NextFunction } from "express";
import cors from "cors";
import * as dotenv from "dotenv";

import "./firebase";
import { requireAuth, ensureSeedUsersOnce, appCheck } from "./auth";
import type { AuthedRequest } from "./auth";
import { requestId, log } from "./log";
import { securityHeaders } from "./security";
import { sendError, notFound } from "./errors";
import { publicRouter } from "./routes/public";
import { sessionRouter } from "./routes/session";
import { usersRouter } from "./routes/users";
import { topicsRouter } from "./routes/topics";
import { sourcesRouter } from "./routes/sources";
import { skillsRouter } from "./routes/skills";
import { projectsRouter } from "./routes/projects";
import { buildRouter } from "./routes/build";
import { memoryRouter } from "./routes/memory";
import { askRouter } from "./routes/ask";
import { designRouter } from "./routes/design";
import { designMapRouter } from "./routes/designMap";
import { plansRouter } from "./routes/plans";
import { dashboardRouter } from "./routes/dashboard";
import { keysRouter } from "./routes/keys";
import { agentRouter } from "./routes/agent";

// GHOST Agent Builder 2.0
// Multi-tenant, read-only GitHub understanding, topics -> sources -> skills,
// project design and plan/prompt generation. Every request is authenticated and
// every document is scoped to its owner.

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  log("warn", "config_missing", { key: "OPENAI_API_KEY", note: "AI endpoints will fail until configured" });
}
if (!process.env.KEYS_ENC_SECRET) {
  log("warn", "config_missing", { key: "KEYS_ENC_SECRET", note: "per-user API key storage will fail until configured" });
}

const isProd = process.env.NODE_ENV === "production" && !process.env.FUNCTIONS_EMULATOR;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// CORS is always an explicit allow-list — we never reflect arbitrary origins.
// When ALLOWED_ORIGINS is set it wins in every environment. When it is empty we
// fall back per environment: prod stays locked down (no cross-origin), while
// dev/emulator defaults to a localhost allow-list instead of echoing back
// whatever Origin header the caller sent (the old `origin: true` behaviour).
const DEV_DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

let corsOrigin: boolean | string[];
if (allowedOrigins.length) {
  corsOrigin = allowedOrigins;
} else if (isProd) {
  log("warn", "cors_locked_down", { note: "ALLOWED_ORIGINS is empty in production; cross-origin requests are blocked" });
  corsOrigin = false;
} else {
  log("info", "cors_dev_default", { note: "ALLOWED_ORIGINS is empty; defaulting to localhost allow-list", origins: DEV_DEFAULT_ORIGINS });
  corsOrigin = DEV_DEFAULT_ORIGINS;
}

const app = express();

app.use(requestId);
app.use(securityHeaders);
app.use(cors({ origin: corsOrigin, credentials: false }));
app.use(express.json({ limit: "4mb" }));

// Firebase Hosting forwards /api/* to this function; strip the prefix.
app.use((req, _res, next) => {
  if (req.url === "/api") req.url = "/";
  else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
  next();
});

// Best-effort seed once per cold start (no per-login seeding).
ensureSeedUsersOnce().catch((err) => log("error", "seed_users_failed", { message: err instanceof Error ? err.message : String(err) }));

// Public routes (no auth).
app.use(publicRouter);

// Firebase App Check (app-integrity attestation). Mounted after publicRouter so
// /health, /login, etc. stay reachable, and before requireAuth so the whole
// authenticated section is attested. Enforcement is staged via APP_CHECK_ENFORCE
// (default "warn") to avoid locking out existing clients during rollout.
app.use(appCheck);

// Everything below requires a valid Bearer session token.
app.use(requireAuth);
app.use(sessionRouter);
app.use(usersRouter);
app.use(topicsRouter);
app.use(sourcesRouter);
app.use(skillsRouter);
app.use(projectsRouter);
app.use(buildRouter);
app.use(memoryRouter);
app.use(askRouter);
app.use(designRouter);
app.use(designMapRouter);
app.use(plansRouter);
app.use(dashboardRouter);
app.use(keysRouter);
app.use(agentRouter);

// Unknown route -> stable not_found envelope.
app.use((req: AuthedRequest, res: Response) => {
  sendError(req, res, notFound());
});

// Final safety net: anything that escaped a route handler.
app.use((err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
  sendError(req, res, err);
});

// In-process vector search loads many embedding vectors into memory per request,
// so the default 256 MiB / 80-concurrency config could exceed memory under load
// (observed: "Memory limit of 256 MiB exceeded", and later a JS-heap OOM crash —
// "Reached heap limit" / SIGABRT — during topic skill extraction). gatherContext
// now runs its subqueries sequentially to cut peak memory; on top of that we give
// the function 2 GiB and keep per-instance concurrency low so two heavy retrieval
// requests can't stack into an OOM on the same instance. Allow longer LLM calls.
// Behaviour/routes are unchanged — this only adjusts runtime resources.
export const api = onRequest(
  { memory: "2GiB", timeoutSeconds: 120, concurrency: 8 },
  app
);

// Async repo ingestion worker (ADR-0002). Cloud Tasks invokes this out-of-band;
// `connect-github` only enqueues. Defined in its own module to keep index lean.
export { ingestWorker } from "./tasks";

// Async project-intelligence scan worker. `/projects/:id/scan` only enqueues;
// the heavy structure/dependency analysis runs here out of band with retries.
export { scanWorker } from "./projectScan";
