import * as crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./firebase";
import { serverTime } from "./util";

export interface AuthedRequest extends Request {
  userId?: string;
  username?: string;
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

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const snap = await db.collection("users").where("sessionToken", "==", token).limit(1).get();
    if (snap.empty) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const doc = snap.docs[0];
    req.userId = doc.id;
    req.username = doc.data().username;
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}
