# SECURITY_REPORT.md

Risk scoring: Critical / High / Medium / Low. Each finding cites evidence and a mitigation.

---

## Summary

The codebase shows above-average security hygiene for an MVP: scrypt password hashing with timing-safe compare, AES-256-GCM encryption of user provider keys, an SSRF guard on outbound URL fetches, read-only GitHub access, "deny-all" Firestore rules, and a CI secret scanner. The notable gaps are around **session lifecycle**, **one plaintext secret**, **login brute-force**, and **input bounds**.

---

## Findings

### S1 — GitHub personal access token stored in plaintext — High
- **Evidence:** `functions/src/routes/projects.ts:79`
  ```ts
  await db.collection("users").doc(req.userId!).update({ githubToken: token });
  ```
  Provider AI keys are encrypted (`crypto.ts`), but the GitHub PAT is written and read (`projects.ts:99`) in cleartext.
- **Attack scenario:** Any Firestore read access (compromised service account, backup leak, misconfig) exposes usable PATs that may grant private-repo or write scopes on the user's GitHub.
- **Exploitability:** Low–Medium (requires datastore access). **Impact:** High.
- **Mitigation:** Reuse `encryptSecret`/`decryptSecret` for `githubToken`; store only an encrypted envelope; never return it (it already isn't returned).

### S2 — Session tokens never expire / cannot be revoked server-side — High
- **Evidence:** Token minted at `routes/public.ts:25-26`; matched at `auth.ts:67`; no `expiresAt`, no rotation; `logout()` only clears `localStorage` (`app/page.tsx:191-195`). Grep for expiry: none in `functions/src`.
- **Attack scenario:** A leaked token (XSS, shared device, logs) is valid forever. Logout does not invalidate it server-side.
- **Impact:** High. **Mitigation:** Add `expiresAt` + check in `requireAuth`; rotate on login; clear `sessionToken` on logout endpoint; consider hashing the stored token.

### S3 — `/login` has no rate limiting (credential brute force) — High
- **Evidence:** `routes/public.ts:14` has no `rateLimit(...)` (compare `ask.ts:11`, `sources.ts:29`). The limiter exists but isn't applied to login.
- **Attack scenario:** Unlimited password guessing against seeded accounts (seed passwords are simple by default, `functions/.env.example:21`).
- **Impact:** High. **Mitigation:** Apply per-username + per-IP throttling to `/login` and a lockout/backoff.

### S4 — Token stored in `localStorage` (XSS exfiltration) — Medium
- **Evidence:** `app/page.tsx:13-17,182`.
- **Attack scenario:** Any XSS can read the bearer token. Combined with S2 (no expiry) this is durable account takeover.
- **Impact:** Medium–High. **Mitigation:** Prefer httpOnly cookie sessions, or accept the tradeoff with short-lived tokens (S2) + strict CSP.

### S5 — CORS reflects all origins by default — Medium
- **Evidence:** `index.ts:42-47` — `origin: allowedOrigins.length ? allowedOrigins : true`; `ALLOWED_ORIGINS` empty by default (`functions/.env.example:25`).
- **Note:** Auth uses bearer tokens (not cookies) and `credentials:false`, so classic CSRF impact is limited, but a permissive default is still a weakness.
- **Mitigation:** Require an explicit allow-list in production.

### S6 — No maximum length on stored API keys / many text inputs — Medium
- **Evidence:** `schemas.ts:58-62` (`ApiKeysSchema` has prefix regex but no `.max()`); flagged as a known gap in `test/keys.test.ts:255-257`. Other free-text fields (topic/project description, instructions) also lack upper bounds; body cap is 4mb (`index.ts:48`).
- **Attack scenario:** Oversized values inflate storage/encryption cost and LLM token spend (cost abuse / DoS).
- **Mitigation:** Add `.max()` bounds across `schemas.ts`.

### S7 — Verbose error messages returned to client — Low
- **Evidence:** Every route returns `err.message` (e.g. `ask.ts:19`, `projects.ts:121`). Upstream provider/GitHub errors may surface internals.
- **Mitigation:** Map to generic messages + server-side log with a correlation id.

### S8 — Per-instance in-memory rate limiter is bypassable — Low/Medium
- **Evidence:** `ratelimit.ts:5-6` (comment acknowledges multi-instance). Limits reset per cold start and per instance.
- **Mitigation:** Back limits with Firestore/Redis for hard quotas on expensive endpoints.

### S9 — Silent fallback to server key on decrypt failure — Low
- **Evidence:** `ai.ts:33-39` — corrupt ciphertext silently uses the env key. Could mask tampering and unexpectedly bill the server key.
- **Mitigation:** Log decrypt failures explicitly; consider failing closed for user-scoped calls.

---

## Positives (verified)

- Passwords: scrypt + random salt + `timingSafeEqual` (`auth.ts:15-24`).
- Key encryption: AES-256-GCM, fresh IV, auth tag, master key via sha256(secret) (`crypto.ts`); round-trip + tamper + wrong-secret tests (`test/crypto.test.ts`, `test/keys.test.ts:151-220`).
- SSRF guard with IPv4/IPv6 private ranges, cloud-metadata `169.254.169.254`, DNS resolution check, 15s timeout, body cap (`ssrf.ts`), tested (`test/ssrf.test.ts`).
- GitHub access is GET-only (`github.ts:20`).
- Firestore rules deny all client access (`firestore.rules:7-8`).
- CI secret scanner blocks committed keys; `.env` gitignored and untracked (`.github/workflows/ci.yml:26-46`, `.gitignore:4-15`, verified `git ls-files` shows no tracked `.env`).

## Security score: 62/100

Good cryptographic and isolation primitives; loses points on session lifecycle (S2), plaintext PAT (S1), unthrottled login (S3), and missing input bounds (S6).
