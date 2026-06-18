import { Router } from "express";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { serverTime } from "../util";
import { ensureSeedUsersOnce, verifyPassword, hashSessionToken, newSessionExpiry } from "../auth";
import type { AuthedRequest } from "../auth";
import { loginThrottle } from "../ratelimit";
import { LoginSchema } from "../schemas";
import { sendError, unauthorized, AppError } from "../errors";
import { log } from "../log";

export const publicRouter = Router();

async function issueSession(ref: FirebaseFirestore.DocumentReference, username: string) {
  const token = crypto.randomBytes(24).toString("hex");
  await ref.set(
    {
      username,
      sessionTokenHash: hashSessionToken(token),
      sessionExpiresAt: newSessionExpiry(),
      sessionUpdatedAt: serverTime(),
      sessionToken: FieldValue.delete(),
      lastLoginAt: serverTime()
    },
    { merge: true }
  );
  return token;
}

publicRouter.get("/health", (_req, res) => {
  res.json({ ok: true, version: "ghost-2.0" });
});

// Readiness probe (contract §1): checks Firestore connectivity and that at least
// one AI key path is configured. Returns 503 when a dependency is unhealthy.
publicRouter.get("/readiness", async (_req, res) => {
  const checks: Record<string, boolean> = { firestore: false, ai: false };
  try {
    await db.collection("users").limit(1).get();
    checks.firestore = true;
  } catch {
    checks.firestore = false;
  }
  checks.ai = Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  const ok = checks.firestore && checks.ai;
  res.status(ok ? 200 : 503).json({ ok, checks });
});

publicRouter.post("/login", async (req: AuthedRequest, res) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);
    const ip = req.ip || req.headers["x-forwarded-for"]?.toString() || "unknown";

    if (!(await loginThrottle(ip, username))) {
      log("warn", "login_rate_limited", { requestId: req.requestId, ip });
      res.status(429).json({ error: "rate_limited", requestId: req.requestId });
      return;
    }

    await ensureSeedUsersOnce();
    const ref = db.collection("users").doc(username.trim().toLowerCase());
    const doc = await ref.get();
    const data = doc.data();
    if (!doc.exists || !data || !verifyPassword(password, data.salt, data.passwordHash)) {
      throw unauthorized();
    }

    // Rotate the session on every successful login. Store only the hash + expiry.
    const token = await issueSession(ref, data.username);
    log("info", "login_success", { requestId: req.requestId, userId: ref.id });
    res.json({ ok: true, token, user: { username: data.username } });
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, requestId: req.requestId });
      return;
    }
    sendError(req, res, err);
  }
});

