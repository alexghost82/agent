import type { Response } from "express";
import { ZodError } from "zod";
import { log } from "./log";
import type { AuthedRequest } from "./auth";

// Stable, machine-readable error codes (integration contract §1). The client
// only ever receives one of these codes plus the requestId — never `err.message`.
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "validation_failed"
  | "not_found"
  | "no_api_key"
  | "github_repo_unavailable"
  | "github_access_denied"
  | "github_token_invalid"
  | "github_api_error"
  | "source_unreachable"
  | "bad_request"
  | "internal";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message?: string
  ) {
    super(message ?? code);
    this.name = "AppError";
  }
}

export const notFound = (message?: string) => new AppError("not_found", 404, message);
export const unauthorized = (message?: string) => new AppError("unauthorized", 401, message);
export const forbidden = (message?: string) => new AppError("forbidden", 403, message);
export const badRequest = (message?: string) => new AppError("bad_request", 400, message);

interface Classified {
  status: number;
  code: ErrorCode;
  message: string;
}

function classify(err: unknown): Classified {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof ZodError) {
    return { status: 400, code: "validation_failed", message: err.message };
  }
  if (err instanceof Error) {
    if (err.message === "no_api_key") {
      return { status: 400, code: "no_api_key", message: err.message };
    }
    return { status: 500, code: "internal", message: err.message };
  }
  return { status: 500, code: "internal", message: String(err) };
}

// Single exit point for route errors: logs the full detail server-side with the
// correlation id, then returns ONLY the stable code + requestId to the client.
export function sendError(req: AuthedRequest, res: Response, err: unknown): void {
  const { status, code, message } = classify(err);
  log(status >= 500 ? "error" : "warn", "request_error", {
    requestId: req.requestId,
    userId: req.userId,
    method: req.method,
    path: req.path,
    status,
    code,
    message,
    stack: status >= 500 && err instanceof Error ? err.stack : undefined
  });
  res.status(status).json({ error: code, requestId: req.requestId });
}
