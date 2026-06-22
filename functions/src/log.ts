import * as crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { recordLatency, recordCounter } from "./telemetry";

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

// Lightweight timing helper: runs `fn`, then emits a latency metric (ms) under
// `metric` and returns `fn`'s result. Sync or async. Latency recording can never
// throw (see telemetry helpers), so this is transparent to callers. Useful for
// timing a discrete unit of work without opening a full span.
export function timed<T>(metric: string, fn: () => T, attrs: Record<string, unknown> = {}): T {
  const start = Date.now();
  const done = (): void => recordLatency(metric, Date.now() - start, attrs as never);
  const result = fn();
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (v) => {
        done();
        return v;
      },
      (err) => {
        done();
        throw err;
      }
    ) as unknown as T;
  }
  done();
  return result;
}

// Express middleware: assign a correlation id to every request. Honors an
// inbound `X-Request-Id` (e.g. from a load balancer) or generates a fresh uuid.
// Also emits per-request latency/throughput metrics on response completion.
// Because this middleware is imported app-wide (index.ts), wiring the metrics
// here propagates request observability without touching the routers.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && incoming.trim()
      ? incoming.trim().slice(0, 200)
      : crypto.randomUUID();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader("X-Request-Id", id);

  const start = Date.now();
  res.on("finish", () => {
    // `req.route?.path` is only set once a route matches; fall back to the base
    // path to keep metric cardinality bounded (avoid raw, high-cardinality URLs).
    const route = (req as Request & { route?: { path?: string } }).route?.path ?? req.baseUrl ?? "unknown";
    const attrs = { method: req.method, status: res.statusCode, route };
    recordLatency("http_server_request_ms", Date.now() - start, attrs);
    recordCounter("http_server_requests_total", attrs);
  });

  next();
}
