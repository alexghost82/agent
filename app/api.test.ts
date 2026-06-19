import { describe, it, expect } from "vitest";
import { ApiError, errorText, errorPayload } from "./api";

const t = {
  requestFailed: "Request failed",
  errorCodes: {
    not_found: "Not found.",
    rate_limited: "Too many requests."
  }
};

describe("ApiError", () => {
  it("carries status, stable code and requestId", () => {
    const e = new ApiError(404, "not_found", "req-123");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ApiError");
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
    expect(e.requestId).toBe("req-123");
    expect(e.message).toBe("not_found");
  });
});

describe("errorText", () => {
  it("maps a known ApiError code to localized text", () => {
    expect(errorText(t, new ApiError(404, "not_found"))).toBe("Not found.");
    expect(errorText(t, new ApiError(429, "rate_limited"))).toBe("Too many requests.");
  });

  it("falls back to the raw code for an unknown ApiError code", () => {
    expect(errorText(t, new ApiError(500, "weird_code"))).toBe("weird_code");
  });

  it("maps a plain Error message through errorCodes when present, else returns it", () => {
    expect(errorText(t, new Error("not_found"))).toBe("Not found.");
    expect(errorText(t, new Error("boom"))).toBe("boom");
  });

  it("uses the requestFailed fallback for non-error values", () => {
    expect(errorText(t, null)).toBe("Request failed");
    expect(errorText(t, "nope")).toBe("Request failed");
    expect(errorText(undefined, null)).toBe("Request failed");
  });
});

describe("errorPayload", () => {
  it("normalizes an ApiError into { error, requestId }", () => {
    expect(errorPayload(new ApiError(403, "forbidden", "rid-9"))).toEqual({
      error: "forbidden",
      requestId: "rid-9"
    });
  });

  it("normalizes a plain Error into { error: message }", () => {
    expect(errorPayload(new Error("kaboom"))).toEqual({ error: "kaboom" });
  });

  it("falls back to internal for unknown thrown values", () => {
    expect(errorPayload("string-error")).toEqual({ error: "internal" });
    expect(errorPayload(undefined)).toEqual({ error: "internal" });
  });
});
