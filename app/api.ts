// Client API layer for GHOST. Adapts to contract §1:
//   error envelope -> { error: "<stable_code>", requestId: "<id>" }
//   server-side logout -> POST /logout (under requireAuth)
// HTTP status codes are preserved; the client maps stable codes to i18n text.

// Configured API base. Empty/unset -> same-origin "/api", which the Firebase
// Hosting rewrite (`/api/** -> the `api` function`) serves. A localhost base is
// only meaningful for local development against the Functions emulator.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0";
}

// Runtime API base with a guard against a dev/emulator base leaking into a
// production bundle. If NEXT_PUBLIC_API_BASE points at localhost/127.0.0.1 (e.g.
// a stray `.env.local` was present at `next build` time) but the app is being
// served from a non-local origin, every request would otherwise be fired at the
// visitor's own machine and fail — surfacing as "Request failed"/"Load error".
// In that case we fall back to same-origin "/api". On the server / during static
// export there is no `window`, so the configured value is returned unchanged.
export function resolveApiBase(): string {
  const configured = API_BASE;
  if (typeof window === "undefined") return configured;
  try {
    if (isLocalHost(window.location.hostname)) return configured; // genuine local dev
    const resolved = new URL(configured, window.location.origin);
    if (isLocalHost(resolved.hostname)) return "/api"; // dev base leaked into prod
  } catch {
    /* relative base ("/api") or unparseable value -> use as-is */
  }
  return configured;
}

export type Json = Record<string, unknown>;

/** Error carrying the stable machine code + requestId from the error envelope. */
export class ApiError extends Error {
  code: string;
  requestId?: string;
  status: number;
  constructor(status: number, code: string, requestId?: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function authHeader(): Record<string, string> {
  try {
    const a = JSON.parse(localStorage.getItem("ghost.auth") || "null");
    return a?.token ? { Authorization: `Bearer ${a.token}` } : {};
  } catch {
    return {};
  }
}

type RequestOptions = { authRedirect?: boolean };

export async function request(
  path: string,
  method: string,
  body?: unknown,
  opts: RequestOptions = {}
): Promise<any> {
  const authRedirect = opts.authRedirect ?? true;
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (res.status === 401 && path !== "/login" && authRedirect) {
    localStorage.removeItem("ghost.auth");
    if (typeof window !== "undefined") window.location.reload();
    throw new ApiError(401, "unauthorized");
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    // Contract §1: stable code lives in `error`; requestId is for support/debug.
    const code = (data && (data.error || data.code)) || "internal";
    throw new ApiError(res.status, String(code), data?.requestId);
  }
  return data;
}

export const getJson = (p: string) => request(p, "GET");
export const postJson = (p: string, b?: unknown) => request(p, "POST", b);
export const patchJson = (p: string, b: unknown) => request(p, "PATCH", b);
export const putJson = (p: string, b: unknown) => request(p, "PUT", b);
export const delJson = (p: string) => request(p, "DELETE");

/** Server-side logout (contract §1). Best-effort: never blocks local sign-out. */
export async function serverLogout(): Promise<void> {
  try {
    await fetch(`${resolveApiBase()}/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() }
    });
  } catch {
    /* network/endpoint not available — local logout still proceeds */
  }
}

/** Map a thrown error to a human message using the active i18n dictionary. */
export function errorText(t: any, e: unknown): string {
  const codes = (t && t.errorCodes) || {};
  if (e instanceof ApiError) {
    return codes[e.code] || e.code || (t && t.requestFailed) || "Request failed";
  }
  if (e instanceof Error && e.message) return codes[e.message] || e.message;
  return (t && t.requestFailed) || "Request failed";
}

/** Normalize a thrown error into the shape stored in `output` for ResultView. */
export function errorPayload(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiError) return { error: e.code, requestId: e.requestId };
  if (e instanceof Error) return { error: e.message };
  return { error: "internal" };
}

/* ---------------- API keys (provider settings) ---------------- */

export type ProviderId = "openai" | "gemini";
export type KeyInfo = { configured: boolean; last4?: string; updatedAt?: string };
export type KeysStatus = { provider: ProviderId; keys: Record<ProviderId, KeyInfo> };
export type KeysBody = { openai?: string | null; gemini?: string | null; provider?: ProviderId };
export type TestResult = { ok: boolean; error?: string };

export const KEYS_MOCK = process.env.NEXT_PUBLIC_API_KEYS_MOCK === "1";
export const KEY_RX: Record<ProviderId, RegExp> = { openai: /^sk-/, gemini: /^AIza/ };
export const PROVIDER_LABEL: Record<ProviderId, string> = { openai: "OpenAI", gemini: "Gemini" };
export const KEY_PLACEHOLDER: Record<ProviderId, string> = { openai: "sk-\u2026", gemini: "AIza\u2026" };

export function keyBody(provider: ProviderId, value: string | null): KeysBody {
  return provider === "openai" ? { openai: value } : { gemini: value };
}

// Local mock state (behind NEXT_PUBLIC_API_KEYS_MOCK). Never holds the raw key.
const mockKeysState: KeysStatus = {
  provider: "openai",
  keys: { openai: { configured: false }, gemini: { configured: false } }
};
const cloneKeys = (s: KeysStatus): KeysStatus => JSON.parse(JSON.stringify(s)) as KeysStatus;

export async function meGetKeys(): Promise<KeysStatus> {
  if (KEYS_MOCK) return cloneKeys(mockKeysState);
  return (await getJson("/me/api-keys")) as KeysStatus;
}
export async function mePutKeys(body: KeysBody): Promise<KeysStatus> {
  if (KEYS_MOCK) {
    (["openai", "gemini"] as ProviderId[]).forEach((p) => {
      if (body[p] === undefined) return;
      const v = body[p];
      mockKeysState.keys[p] = v
        ? { configured: true, last4: v.slice(-4), updatedAt: new Date().toISOString() }
        : { configured: false };
    });
    if (body.provider) mockKeysState.provider = body.provider;
    return cloneKeys(mockKeysState);
  }
  return (await putJson("/me/api-keys", body)) as KeysStatus;
}
export async function meTestKey(provider: ProviderId): Promise<TestResult> {
  if (KEYS_MOCK) {
    const k = mockKeysState.keys[provider];
    return k.configured ? { ok: true } : { ok: false, error: "not_configured" };
  }
  return (await postJson("/me/api-keys/test", { provider })) as TestResult;
}

/* ---------------- Downloads ---------------- */

export function downloadMd(name: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".md") ? name : `${name}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
