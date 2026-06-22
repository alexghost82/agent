import * as crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { getAppCheck } from "firebase-admin/app-check";
import { db, admin } from "./firebase";
import { serverTime } from "./util";
import { log } from "./log";
import { sendError, forbidden } from "./errors";

export interface AuthedRequest extends Request {
  userId?: string;
  username?: string;
  role?: UserRole;
  requestId?: string;
}

export type UserRole = "admin" | "member";

// Session transport (SECURITY v2): in addition to the Authorization: Bearer
// header (used by the iOS/native client), the web client authenticates via an
// httpOnly cookie. Because Firebase Hosting rewrites `/api/**` to this function,
// the browser and the API share an origin, so a SameSite=Strict cookie is sent
// on same-origin XHR while being immune to cross-site (CSRF) sends. Storing the
// session in an httpOnly cookie removes the localStorage XSS token-theft vector.
export const SESSION_COOKIE = "gh_session";

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Bearer header takes precedence; the cookie is the browser fallback.
export function sessionTokenFromRequest(req: Request): string {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t) return t;
  }
  return parseCookies(req.headers.cookie).gh_session || "";
}

function cookieAttrs(extra: string[]): string {
  const attrs = [`Path=/`, "HttpOnly", "SameSite=Strict", ...extra];
  // Secure cannot be set over plain http (emulator/local); HSTS-style gate.
  if (!process.env.FUNCTIONS_EMULATOR) attrs.push("Secure");
  return attrs.join("; ");
}

export function setSessionCookie(res: Response, token: string): void {
  const maxAge = Math.floor(sessionTtlMs() / 1000);
  res.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs([`Max-Age=${maxAge}`])}`);
}

export function clearSessionCookie(res: Response): void {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttrs(["Max-Age=0"])}`);
}

// Middleware factory: gate a route on a role. Must run after requireAuth.
export function requireRole(role: UserRole) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (req.role !== role) {
      res.status(403).json({ error: "forbidden", requestId: req.requestId });
      return;
    }
    next();
  };
}

export function makeSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Session tokens are never stored raw: we persist sha256(token) and compare
// hashes. A leaked Firestore dump therefore cannot be replayed as a bearer.
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 168) * 60 * 60 * 1000;
}

export function newSessionExpiry(): Timestamp {
  return Timestamp.fromMillis(Date.now() + sessionTtlMs());
}

// Seed users come from configuration, never from source code.
// Format: SEED_USERS="Alex:passA,Omer:passB"
function seedUsers(): { username: string; password: string }[] {
  const raw = process.env.SEED_USERS || "";
  return raw
    .split(",")
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx === -1) return null;
      const username = pair.slice(0, idx).trim();
      const password = pair.slice(idx + 1).trim();
      if (!username || !password) return null;
      return { username, password };
    })
    .filter((x): x is { username: string; password: string } => x !== null);
}

export async function ensureSeedUsers(): Promise<void> {
  for (const u of seedUsers()) {
    const ref = db.collection("users").doc(u.username.toLowerCase());
    const doc = await ref.get();
    if (!doc.exists) {
      const salt = makeSalt();
      await ref.set({
        username: u.username,
        salt,
        passwordHash: hashPassword(u.password, salt),
        // Seed users are the platform operators; everyone else is a member.
        role: "admin",
        createdAt: serverTime()
      });
    }
  }
}

// Run seeding at most once per instance instead of on every login request.
let seedPromise: Promise<void> | null = null;
export function ensureSeedUsersOnce(): Promise<void> {
  if (!seedPromise) {
    seedPromise = ensureSeedUsers().catch((err) => {
      // Allow a later retry if seeding failed (e.g. transient Firestore error).
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

// Server-side verification of a Firebase Auth ID token (CONTRACT v3 / §9 iOS).
// The mobile client authenticates with Firebase, sends the ID token, and the
// backend verifies it with the Admin SDK before issuing a GHOST session. Throws
// on any invalid/expired token.
export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  name?: string;
}
export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return { uid: decoded.uid, email: decoded.email, name: (decoded as { name?: string }).name };
}

// Firebase App Check (app-integrity attestation). This is orthogonal to
// requireAuth: requireAuth proves *who* the user is, App Check proves the
// request came from *our* app/device, not a scripted client. Enforcement is
// staged via APP_CHECK_ENFORCE so we can observe traffic before locking it down:
//   off     – skip entirely (no header read, no verification).
//   warn    – verify when a token is present, log failures/absence, always allow
//             (default; keeps the existing web client working during rollout).
//   enforce – reject any request without a valid App Check token.
// The header is X-Firebase-AppCheck (per the Firebase client SDKs). App Check is
// always skipped under the emulator, which has no attestation provider.
export type AppCheckMode = "off" | "warn" | "enforce";

const APP_CHECK_HEADER = "x-firebase-appcheck";

export function appCheckMode(): AppCheckMode {
  const raw = (process.env.APP_CHECK_ENFORCE || "warn").trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "warn";
}

export async function appCheck(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  // The emulator has no App Check provider; never gate local development on it.
  if (process.env.FUNCTIONS_EMULATOR) {
    next();
    return;
  }

  const mode = appCheckMode();
  if (mode === "off") {
    next();
    return;
  }

  const header = req.headers[APP_CHECK_HEADER];
  const token = (Array.isArray(header) ? header[0] : header)?.trim() || "";

  if (!token) {
    if (mode === "enforce") {
      sendError(req, res, forbidden("app_check_required"));
      return;
    }
    log("warn", "app_check_missing", { requestId: req.requestId, userId: req.userId, mode });
    next();
    return;
  }

  try {
    await getAppCheck().verifyToken(token);
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", "app_check_invalid", { requestId: req.requestId, userId: req.userId, mode, message });
    if (mode === "enforce") {
      sendError(req, res, forbidden("app_check_invalid"));
      return;
    }
    next();
  }
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = sessionTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "unauthorized", requestId: req.requestId });
      return;
    }
    const tokenHash = hashSessionToken(token);
    const snap = await db.collection("users").where("sessionTokenHash", "==", tokenHash).limit(1).get();
    if (snap.empty) {
      res.status(401).json({ error: "unauthorized", requestId: req.requestId });
      return;
    }
    const doc = snap.docs[0];
    const expiresAt = doc.data().sessionExpiresAt as Timestamp | undefined;
    if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
      res.status(401).json({ error: "unauthorized", requestId: req.requestId });
      return;
    }
    req.userId = doc.id;
    req.username = doc.data().username;
    req.role = doc.data().role === "admin" ? "admin" : "member";
    next();
  } catch {
    res.status(401).json({ error: "unauthorized", requestId: req.requestId });
  }
}
