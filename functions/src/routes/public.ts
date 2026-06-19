import { Router } from "express";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { serverTime } from "../util";
import { ensureSeedUsersOnce, verifyPassword, hashSessionToken, newSessionExpiry, verifyFirebaseIdToken, setSessionCookie, makeSalt, hashPassword } from "../auth";
import type { AuthedRequest } from "../auth";
import { loginThrottle, consumeDistributed } from "../ratelimit";
import { LoginSchema, FirebaseAuthSchema, AcceptInviteSchema } from "../schemas";
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
    setSessionCookie(res, token);
    log("info", "login_success", { requestId: req.requestId, userId: ref.id });
    res.json({ ok: true, token, user: { username: data.username, role: data.role === "admin" ? "admin" : "member" } });
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, requestId: req.requestId });
      return;
    }
    sendError(req, res, err);
  }
});

// Redeem an invite to create an account (SECURITY v2 / user management). Public
// because the invitee has no session yet; protected by an unguessable code, a
// single-use marker, an expiry, and a per-IP distributed throttle.
publicRouter.post("/accept-invite", async (req: AuthedRequest, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"]?.toString() || "unknown";
    if (!(await consumeDistributed(`accept-invite:ip:${ip}`, 20, 15 * 60_000))) {
      res.status(429).json({ error: "rate_limited", requestId: req.requestId });
      return;
    }
    const { code, username, password } = AcceptInviteSchema.parse(req.body);
    const inviteRef = db.collection("invites").doc(code);
    const inviteSnap = await inviteRef.get();
    const invite = inviteSnap.data();
    if (!inviteSnap.exists || !invite || invite.used) throw unauthorized();
    if (invite.expireAt && (invite.expireAt as { toMillis(): number }).toMillis() <= Date.now()) throw unauthorized();

    const userId = username.trim().toLowerCase();
    const userRef = db.collection("users").doc(userId);
    if ((await userRef.get()).exists) {
      res.status(409).json({ error: "bad_request", requestId: req.requestId });
      return;
    }

    const salt = makeSalt();
    await userRef.set({
      username: username.trim(),
      salt,
      passwordHash: hashPassword(password, salt),
      role: invite.role === "admin" ? "admin" : "member",
      invitedBy: invite.createdBy || null,
      createdAt: serverTime()
    });
    await inviteRef.update({ used: true, usedBy: userId, usedAt: serverTime() });

    const token = await issueSession(userRef, username.trim());
    setSessionCookie(res, token);
    log("info", "invite_accepted", { requestId: req.requestId, userId });
    res.json({ ok: true, token, user: { username: username.trim(), role: invite.role === "admin" ? "admin" : "member" } });
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, requestId: req.requestId });
      return;
    }
    sendError(req, res, err);
  }
});

// iOS/mobile transport (CONTRACT §9 / v3): verify a Firebase Auth ID token with
// the Admin SDK, then issue a GHOST session bearer. The user doc is keyed by the
// Firebase uid (`fb_<uid>`) and isolated like any other user.
publicRouter.post("/auth/firebase", async (req: AuthedRequest, res) => {
  try {
    const { idToken } = FirebaseAuthSchema.parse(req.body);
    let verified;
    try {
      verified = await verifyFirebaseIdToken(idToken);
    } catch {
      throw unauthorized();
    }
    const username = verified.name || verified.email || `user_${verified.uid.slice(0, 8)}`;
    const ref = db.collection("users").doc(`fb_${verified.uid}`);
    if (!(await ref.get()).exists) await ref.set({ createdAt: serverTime(), authProvider: "firebase", role: "member" }, { merge: true });
    const token = await issueSession(ref, username);
    setSessionCookie(res, token);
    log("info", "firebase_auth_success", { requestId: req.requestId, userId: ref.id });
    res.json({ ok: true, token, user: { username } });
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, requestId: req.requestId });
      return;
    }
    sendError(req, res, err);
  }
});

