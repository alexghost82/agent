// Telemetry MUST load before express/http so the OpenTelemetry SDK starts and
// patches those modules for auto-instrumentation before they are evaluated.
// This module self-initializes on import (guarded no-op in tests/emulator).
// Keep this as the FIRST import.
import "./telemetry";

import { onRequest } from "firebase-functions/v2/https";
import type { MemoryOption } from "firebase-functions/v2/options";
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

// --- Runtime sizing -------------------------------------------------------
// History: in-process vector search loaded many embedding vectors into memory
// per request, which caused OOM under load ("Memory limit … exceeded", and a
// JS-heap "Reached heap limit" / SIGABRT during skill extraction). The previous
// mitigation was 2 GiB + concurrency 8 (few heavy retrievals could stack per
// instance). gatherContext also runs its subqueries sequentially to cap peak
// memory at a single candidate set.
//
// Now the Firestore Vector Search backend (Agent A, VECTOR_BACKEND="firestore")
// is the intended default: `findNearest` returns only the top-k chunks
// server-side, so per-request retrieval memory drops from "a capped candidate
// set" (up to VECTOR_CANDIDATE_CAP=1500 vectors) to ~k chunks (default 8). That
// lets us halve memory to 1 GiB and raise concurrency for better throughput and
// lower cost, while keeping the timeout long enough for LLM calls.
//
// IMPORTANT — this tuning ASSUMES the Firestore vector backend. The in-memory
// cosine fallback still exists per request (memory.ts), and selectVectorBackend
// returns "memory" unless VECTOR_BACKEND="firestore". 1 GiB (not 512 MiB) is the
// deliberate floor: it absorbs an OCCASIONAL single in-memory fallback request
// (one capped candidate set is on the order of tens of MiB) without OOM, but it
// is NOT sized for SUSTAINED in-memory search at high concurrency. If you force
// VECTOR_BACKEND=memory, raise FUNCTION_MEMORY back to 2GiB (and/or lower
// FUNCTION_CONCURRENCY) — see docs/notes/runtime-load-test.md.
//
// All three values stay env-overridable for ops tuning without a code change.
const RUNTIME_MEMORY = (process.env.FUNCTION_MEMORY || "1GiB") as MemoryOption;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const RUNTIME_CONCURRENCY = envInt("FUNCTION_CONCURRENCY", 60);
const RUNTIME_TIMEOUT_SECONDS = envInt("FUNCTION_TIMEOUT_SECONDS", 120);

// Guard: warn (once per cold start) when the reduced ceiling is paired with the
// in-memory vector backend, which is the OOM-prone path the 1 GiB floor only
// tolerates for the occasional single fallback — not for sustained load.
if (process.env.VECTOR_BACKEND !== "firestore" && RUNTIME_MEMORY !== "2GiB" && RUNTIME_MEMORY !== "4GiB") {
  log("warn", "runtime_memory_backend_mismatch", {
    note:
      "VECTOR_BACKEND is not 'firestore' so in-memory cosine search may load a full candidate set per request. " +
      "The reduced memory ceiling tolerates an occasional single fallback but is not sized for sustained in-memory " +
      "search at high concurrency — set VECTOR_BACKEND=firestore, or raise FUNCTION_MEMORY (e.g. 2GiB) and/or lower FUNCTION_CONCURRENCY.",
    memory: RUNTIME_MEMORY,
    concurrency: RUNTIME_CONCURRENCY,
  });
}

// Behaviour/routes are unchanged — this only adjusts runtime resources.
export const api = onRequest(
  { memory: RUNTIME_MEMORY, timeoutSeconds: RUNTIME_TIMEOUT_SECONDS, concurrency: RUNTIME_CONCURRENCY },
  app
);

// Async repo ingestion worker (ADR-0002). Cloud Tasks invokes this out-of-band;
// `connect-github` only enqueues. Defined in its own module to keep index lean.
export { ingestWorker } from "./tasks";

// Async project-intelligence scan worker. `/projects/:id/scan` only enqueues;
// the heavy structure/dependency analysis runs here out of band with retries.
export { scanWorker } from "./projectScan";
