import * as crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// Structured (JSON-line) logging to stdout/stderr. Cloud Functions / Cloud
// Logging parse one JSON object per line. Every entry carries an event name and
// optional correlation fields (requestId, userId) so logs can be traced.

export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry: Record<string, unknown> = {
    severity: level.toUpperCase(),
    level,
    event,
    time: new Date().toISOString(),
    ...fields
  };
  // Drop undefined values so log lines stay compact.
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Express middleware: assign a correlation id to every request. Honors an
// inbound `X-Request-Id` (e.g. from a load balancer) or generates a fresh uuid.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && incoming.trim()
      ? incoming.trim().slice(0, 200)
      : crypto.randomUUID();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
