import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";
import { consumeDistributed } from "./ratelimit";
import { log } from "./log";

// Security headers (CONTRACT v3 / SECURITY). This is a JSON API (no HTML is
// served from the function), so the CSP is maximally locked down. HSTS is only
// meaningful over HTTPS and is emitted outside the emulator.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  if (!process.env.FUNCTIONS_EMULATOR) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
}

// Distributed, cross-instance hard quota (CONTRACT v3 / ADR-0003) for expensive
// AI/ingest endpoints. Complements the per-instance in-memory `rateLimit`:
// fail-open on limiter infra errors is handled inside `consumeDistributed`.
export function distributedRateLimit(name: string, limit: number, windowMs: number) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const key = `${name}:${req.userId || req.ip || "anon"}`;
    const ok = await consumeDistributed(key, limit, windowMs);
    if (!ok) {
      log("warn", "distributed_rate_limited", { requestId: req.requestId, scope: name, userId: req.userId });
      res.status(429).json({ error: "rate_limited", requestId: req.requestId });
      return;
    }
    next();
  };
}
