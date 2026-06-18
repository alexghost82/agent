import type { Response, NextFunction } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import type { AuthedRequest } from "./auth";
import { log } from "./log";

// Best-effort, per-instance in-memory limiter. Cloud Functions run multiple
// instances, so this is a soft guard against abuse / cost spikes, not a hard quota.
const buckets = new Map<string, { count: number; reset: number }>();

export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function rateLimit(name: string, limit: number, windowMs: number) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const key = `${name}:${req.userId || req.ip || "anon"}`;
    if (!allow(key, limit, windowMs)) {
      log("warn", "rate_limited", { requestId: req.requestId, scope: name, key });
      res.status(429).json({ error: "rate_limited", requestId: req.requestId });
      return;
    }
    next();
  };
}

// Distributed fixed-window limiter backed by Firestore. Used for hard quotas
// that must hold across instances/cold-starts (e.g. login brute-force). Each
// counter document carries an `expireAt` so a Firestore TTL policy can reap it.
export async function consumeDistributed(key: string, limit: number, windowMs: number): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const docId = `${key}:${windowStart}`.replace(/\//g, "_");
  const ref = db.collection("rate_limits").doc(docId);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data()?.count as number) || 0 : 0;
      if (count >= limit) return false;
      tx.set(
        ref,
        {
          count: FieldValue.increment(1),
          expireAt: Timestamp.fromMillis(windowStart + windowMs * 2)
        },
        { merge: true }
      );
      return true;
    });
  } catch (err) {
    // Fail open on limiter infrastructure errors rather than blocking real users.
    log("warn", "distributed_rate_limit_error", { key, message: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

// Login throttle: per-IP and per-username windows to slow credential stuffing.
export async function loginThrottle(ip: string, username: string): Promise<boolean> {
  const windowMs = 15 * 60_000;
  const ipOk = await consumeDistributed(`login:ip:${ip || "unknown"}`, 30, windowMs);
  const userOk = await consumeDistributed(`login:user:${username.toLowerCase()}`, 10, windowMs);
  return ipOk && userOk;
}
