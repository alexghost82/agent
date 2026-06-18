import * as crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { serverTime } from "./util";

export interface AuthedRequest extends Request {
  userId?: string;
  username?: string;
  requestId?: string;
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

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
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
    next();
  } catch {
    res.status(401).json({ error: "unauthorized", requestId: req.requestId });
  }
}
