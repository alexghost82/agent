import * as functions from "firebase-functions";
import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";

import "./firebase";
import { requireAuth } from "./auth";
import { publicRouter } from "./routes/public";
import { topicsRouter } from "./routes/topics";
import { sourcesRouter } from "./routes/sources";
import { skillsRouter } from "./routes/skills";
import { projectsRouter } from "./routes/projects";
import { askRouter } from "./routes/ask";
import { designRouter } from "./routes/design";
import { plansRouter } from "./routes/plans";
import { dashboardRouter } from "./routes/dashboard";

// GHOST Agent Builder 2.0
// Multi-tenant, read-only GitHub understanding, topics -> sources -> skills,
// project design and plan/prompt generation. Every request is authenticated and
// every document is scoped to its owner.

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  // Logged, not thrown, so /health and /login still work without AI configured.
  console.error("[ghost] WARNING: OPENAI_API_KEY is not set. AI endpoints will fail until it is configured.");
}

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: false
  })
);
app.use(express.json({ limit: "4mb" }));

// Firebase Hosting forwards /api/* to this function; strip the prefix.
app.use((req, _res, next) => {
  if (req.url === "/api") req.url = "/";
  else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
  next();
});

// Public routes (no auth).
app.use(publicRouter);

// Everything below requires a valid Bearer session token.
app.use(requireAuth);
app.use(topicsRouter);
app.use(sourcesRouter);
app.use(skillsRouter);
app.use(projectsRouter);
app.use(askRouter);
app.use(designRouter);
app.use(plansRouter);
app.use(dashboardRouter);

export const api = functions.https.onRequest(app);
