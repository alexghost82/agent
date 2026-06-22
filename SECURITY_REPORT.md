# SECURITY_REPORT.md

Risk scoring: Critical / High / Medium / Low. Each finding cites evidence and a mitigation.

---

## Summary

The codebase shows strong security hygiene for its stage: scrypt password hashing
with timing-safe compare, AES-256-GCM encryption of user provider keys **and** the
GitHub PAT, hashed-and-expiring session tokens with server-side logout, a
distributed login throttle, an SSRF guard on outbound fetches, read-only GitHub
access, deny-all Firestore rules, input bounds on all schemas, a coded error
envelope, and a CI secret scanner. The 2026-06-22 hardening orchestration
additionally closed both SSRF classes (redirect-follow + DNS-rebinding TOCTOU),
replaced the permissive dev CORS default with an explicit allow-list, added staged
Firebase App Check, and introduced AES key versioning/rotation. The remaining gaps
are now **rollout-dependent**: the **`localStorage` session token** and completing
the **App Check `warn → enforce`** rollout.

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

## Resolved in the 2026-06-22 hardening orchestration (verified per branch)

Each item below is fixed on a committed feature branch (isolated worktree, ready
for merge — see [`docs/notes/integration-plan.md`](docs/notes/integration-plan.md)).

- **Redirect-follow SSRF closed** — outbound fetches now follow redirects
  **manually** with per-hop revalidation through the SSRF guard and a 5-hop cap,
  so a public URL can no longer redirect into a private/metadata address.
  *Evidence:* `feature/ssrf-hardening` (`f89ac63`) — `functions/src/ssrf.ts`,
  `functions/test/ssrf.test.ts`.
- **DNS-rebinding TOCTOU closed** — the resolved/validated IP is **pinned** for the
  actual connection via an undici dispatcher that preserves Host/SNI, eliminating
  the resolve-then-connect race. *Evidence:* `feature/ssrf-hardening` (`f89ac63`) —
  `functions/src/ssrf.ts`.
- **CORS reflect-all removed** — the permissive dev/emulator origin reflection is
  replaced by an explicit localhost allow-list (was finding **S5**).
  *Evidence:* `feature/app-check` (`d073f97`) — `functions/src/index.ts`.
- **Firebase App Check added (staged)** — App Check verification on the authed
  section with `off`/`warn`/`enforce` modes (default `warn`, emulator-bypass),
  adding client-attestation defense for the API. *Evidence:* `feature/app-check`
  (`d073f97`) — `functions/src/index.ts`, `functions/src/auth.ts`,
  `functions/test/appcheck.test.ts`.
- **Encryption key versioning & rotation** — `EncryptedSecret` gains an optional
  `v` (key version), with an idempotent dry-run rotation migration and a runbook;
  fully backward-compatible (missing version ⇒ v1). *Evidence:*
  `feature/key-rotation` (`69f5f20`) — `functions/src/crypto.ts`,
  `functions/test/crypto.test.ts`, `functions/scripts/rotate-keys.ts`,
  `docs/notes/key-rotation.md`.

## Open findings

### S4 — Session token stored in `localStorage` (XSS exfiltration) — Medium
- **Evidence:** `app/api.ts:26-27` reads `ghost.auth` from `localStorage` and
  sends it as `Authorization: Bearer`; persisted in `app/useGhostData.ts:80`.
- **Attack scenario:** Any XSS can read the bearer token. Mitigated by the new
  hard session expiry (no longer durable forever), but still a real exposure.
- **Mitigation:** Prefer httpOnly cookie sessions, or keep short-lived tokens
  plus a strict CSP.

### S5 — CORS allows all origins outside production — RESOLVED (2026-06-22)
- **Status:** Fixed on `feature/app-check` (`d073f97`) — the reflect-all dev
  default is replaced by an explicit localhost allow-list in
  `functions/src/index.ts`. Retained here for traceability.

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

## Residual risks (rollout-dependent)

These are not code gaps but deployment/rollout items tracked in
[`docs/notes/integration-plan.md`](docs/notes/integration-plan.md):

- **App Check is in `warn` mode** — attestation failures are logged but not yet
  rejected. The API is not yet protected against non-attested clients until
  `APP_CHECK_ENFORCE=enforce`.
- **App Check `warn → enforce` rollout** — the web client must initialize the
  App Check SDK and send `X-Firebase-AppCheck` on every request **before** flipping
  to `enforce`, or legitimate traffic will be rejected. Consider dedicated error
  codes in `errors.ts` for App Check rejections.
- **Session token in `localStorage` (S4)** — unchanged; still XSS-exfiltratable.
- **Per-route rate limiter is per-instance (S6)** — unchanged.
- **Key rotation is provisioned, not yet executed** — versioning + migration ship
  on `feature/key-rotation`; a first rotation should be scheduled per its runbook.

## Security score: 86/100 (was 80)

The 2026-06-22 orchestration closed the two SSRF classes (redirect-follow and
DNS-rebinding TOCTOU), removed the permissive CORS default, added staged App Check,
and introduced AES key versioning/rotation. The remaining points reflect
**rollout** rather than missing controls: App Check still in `warn` (S-AppCheck),
client-side token storage (S4), and the per-instance AI-endpoint limiter (S6).
