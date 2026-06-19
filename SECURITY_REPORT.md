# SECURITY_REPORT.md

Risk scoring: Critical / High / Medium / Low. Each finding cites evidence and a mitigation.

---

## Summary

The codebase shows strong security hygiene for its stage: scrypt password hashing
with timing-safe compare, AES-256-GCM encryption of user provider keys **and** the
GitHub PAT, hashed-and-expiring session tokens with server-side logout, a
distributed login throttle, an SSRF guard on outbound fetches, read-only GitHub
access, deny-all Firestore rules, input bounds on all schemas, a coded error
envelope, and a CI secret scanner. The remaining gaps are the **`localStorage`
session token** and the **permissive CORS default in non-production**.

---

## Resolved since the previous report (verified in code)

- **GitHub PAT now encrypted at rest** — `/github-token` stores an
  `encryptSecret` envelope; reads decrypt via `readGithubToken` with a
  legacy-plaintext fallback (`routes/projects.ts:92-101,22-38`). (was S1)
- **Session lifecycle hardened** — only `sessionTokenHash` is stored,
  `sessionExpiresAt` is enforced in `requireAuth`, the token rotates on login,
  and `POST /logout` invalidates it server-side (`auth.ts:28-41,89-115`,
  `routes/public.ts:15-29`, `routes/session.ts`). (was S2)
- **`/login` throttled** — per-IP + per-username distributed limiter
  (`ratelimit.ts loginThrottle/consumeDistributed`, applied at
  `routes/public.ts:55`). (was S3)
- **Input bounds added** — every zod field has `.max()`, including
  `ApiKeysSchema` (`schemas.ts`). (was S6)
- **Coded error envelope** — routes return `{ error, requestId }` with the full
  detail logged server-side only (`errors.ts`). (was S7)
- **Decrypt failures are logged**, not silently swallowed; the env-key fallback
  is intentional for availability (`ai.ts:46-54`). (was S9, downgraded)

## Open findings

### S4 — Session token stored in `localStorage` (XSS exfiltration) — Medium
- **Evidence:** `app/api.ts:26-27` reads `ghost.auth` from `localStorage` and
  sends it as `Authorization: Bearer`; persisted in `app/useGhostData.ts:80`.
- **Attack scenario:** Any XSS can read the bearer token. Mitigated by the new
  hard session expiry (no longer durable forever), but still a real exposure.
- **Mitigation:** Prefer httpOnly cookie sessions, or keep short-lived tokens
  plus a strict CSP.

### S5 — CORS allows all origins outside production — Low/Medium
- **Evidence:** `index.ts:47-55` — with no `ALLOWED_ORIGINS`, production blocks
  cross-origin requests but development/emulator reflects all origins
  (`corsOrigin = true`).
- **Note:** Auth uses bearer tokens (not cookies) with `credentials:false`, so
  classic CSRF impact is limited; the permissive dev default is the residual
  weakness.
- **Mitigation:** Document/require an explicit allow-list in any internet-exposed
  non-prod environment.

### S6 — Per-route rate limiter is in-memory (per-instance) — Low/Medium
- **Evidence:** `ratelimit.ts:9-33` (`allow`/`rateLimit`) is per-instance; only
  login uses the Firestore-backed `consumeDistributed`.
- **Impact:** Expensive AI endpoints can be over-served across instances / after
  cold starts.
- **Mitigation:** Back the AI-endpoint limits with `consumeDistributed` (or
  Redis) for hard cross-instance quotas.

---

## Positives (verified)

- Passwords: scrypt + random salt + `timingSafeEqual` (`auth.ts:13-26`).
- Key encryption: AES-256-GCM, fresh IV, auth tag, master key via
  `sha256(secret)` (`crypto.ts`); round-trip + tamper + wrong-secret tests
  (`test/crypto.test.ts`, `test/keys.test.ts`).
- Session tokens: stored as sha256 hash, hard expiry, rotate on login, revoked on
  logout (`auth.ts`, `routes/session.ts`).
- SSRF guard: IPv4/IPv6 private ranges, cloud-metadata `169.254.169.254`, DNS
  resolution check, timeout, body cap (`ssrf.ts`), tested (`test/ssrf.test.ts`).
- GitHub access is GET-only (`github.ts`); BUILD (when wired) writes only to the
  owner's Firestore workspace, never to GitHub (CONTRACT §v2.2).
- Firestore rules deny all client access (`firestore.rules`).
- CI secret scanner blocks committed keys; `.env*` gitignored and untracked
  (`.github/workflows/ci.yml`, `.gitignore`).

## Security score: 80/100

Strong cryptographic, session, and isolation primitives. Remaining points are the
client-side token storage (S4) and the non-prod CORS default (S5); distributing
the AI-endpoint rate limit (S6) would harden cost/abuse controls.
