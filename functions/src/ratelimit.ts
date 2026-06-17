import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";

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
      res.status(429).json({ error: "rate_limited", message: "Too many requests, slow down." });
      return;
    }
    next();
  };
}
