# Security — per-user provider API keys

Threat model and security checklist for the "bring your own API key" feature
(OpenAI + Gemini), covering `functions/src/crypto.ts`, `routes/keys.ts`, `ai.ts`,
`providers/*`, and the `app/page.tsx` settings UI. This complements the
repo-level notes in the root `SECURITY.md`.

## Assets

- **Raw provider API keys** (OpenAI / Gemini) supplied by each user. These are
  billable secrets and the primary asset to protect.
- **`KEYS_ENC_SECRET`** — the server master secret used to encrypt every stored
  key. Compromise of this secret compromises every stored key.
- **Server fallback keys** — `OPENAI_API_KEY` / `GEMINI_API_KEY` in the function
  environment.
- **Session tokens** in `users/{id}.sessionToken` used by `requireAuth`.

## Trust boundaries

- **Browser ↔ Functions**: untrusted client over HTTPS. The browser may send a
  raw key on `PUT /me/api-keys`, but must never receive one back.
- **Functions ↔ Firestore**: keys are persisted only as an AES-256-GCM envelope
  on the owner's user document. Direct client access to Firestore is denied;
  all access goes through the Admin SDK.
- **Functions ↔ provider APIs**: the decrypted key lives in memory only for the
  duration of a call (plus a per-key client cache) and is sent only to the
  matching provider over TLS.

## Data-flow invariants (FROZEN contract)

1. **At-rest encryption.** Keys are stored only as `{ ciphertext, iv, tag }`
   (AES-256-GCM, 12-byte random IV, 16-byte auth tag), derived from
   `KEYS_ENC_SECRET`. The raw key is never persisted.
2. **No raw key egress.** `GET`/`PUT /me/api-keys` return only
   `{ configured, last4?, updatedAt? }` per provider. `last4` is the only
   cleartext fragment ever exposed.
3. **Format validation.** OpenAI keys must match the `sk-` prefix and Gemini
   keys the `AIza` prefix (zod, server-side).
4. **Key resolution.** user key for the active provider → server env key →
   `no_api_key`. Decrypt failures fall back to the env key rather than crashing.
5. **Isolation.** Every read/write is scoped to `req.userId`; the keys router is
   mounted **after** `requireAuth`. User A can never read or use user B's key.
6. **No secret logging.** Audit events record only `set` / `deleted` /
   `unchanged` flags and the chosen provider — never key material.

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|--------|-----------|--------|
| T1 | Secret committed to VCS | `.env` gitignored; CI secret scan; review | See incident below |
| T2 | Key returned to client | Masked status DTO only (`configured/last4/updatedAt`) | OK |
| T3 | Key readable in DB dump | AES-256-GCM envelope; master secret in env only | OK |
| T4 | Cross-tenant access | `requireAuth` + strict `req.userId` scoping | OK |
| T5 | Ciphertext tampering | GCM auth tag rejects modified ciphertext/IV/tag | OK |
| T6 | Key leak via logs/errors | No key in logs; provider error messages are generic-ish | Partial — see B5 |
| T7 | Abuse / cost via live key test | Rate-limit `POST /me/api-keys/test` | **MISSING — see B3** |
| T8 | Oversized payload (DoS/storage) | zod `.max()` on key length | **MISSING — see B4** |
| T9 | Master-secret compromise | Rotate `KEYS_ENC_SECRET`; ≥32 bytes high-entropy | Operational |

## Incident: leaked `OPENAI_API_KEY`

A real, working `OPENAI_API_KEY` was present in plaintext in `functions/.env`.

- The value has been **redacted** from `functions/.env` by this review.
- `functions/.env` is **gitignored** and is **not** tracked by git, and the key
  was **not** found in git history — exposure was limited to the working tree.
- **REQUIRED (human action):** the leaked key is compromised and MUST be
  **revoked/rotated** in the OpenAI dashboard. Treat as exposed regardless of
  git status. A freshly rotated key may be placed in the local (gitignored)
  `functions/.env` for development only.

## Checklist

- [x] Keys never returned to the client (`configured/last4/updatedAt` only).
- [x] Keys encrypted at rest (AES-256-GCM); master secret only in env.
- [x] No key material in logs; audit events store flags only.
- [x] Tenant isolation: scoped by `req.userId`, router behind `requireAuth`.
- [x] Format validation (`sk-` / `AIza`) via zod.
- [x] GCM integrity: tampered ciphertext and wrong master secret are rejected.
- [ ] Rate-limit on `POST /me/api-keys/test` (currently absent).
- [ ] Size/length validation on key values (zod `.max()` absent).
- [ ] Leaked `OPENAI_API_KEY` revoked/rotated (human action, pending).

## Operational notes

- `KEYS_ENC_SECRET` must be a high-entropy secret (≥32 random bytes). It is
  hashed to a 256-bit key via SHA-256, so its strength equals its own entropy.
- Restrict CORS in production via `ALLOWED_ORIGINS`.
- Never commit `functions/.env` or any real key; the CI secret scan and
  `functions/test/keys.test.ts` guard against regressions.

## iOS client security

The iOS app is a public client and must be treated as untrusted.

Invariants:

- Store backend bearer sessions only in Keychain.
- Never log bearer tokens, Firebase ID tokens, provider API keys, or full request
  bodies.
- Do not use the Firestore client SDK for product data. The app calls Cloud
  Functions endpoints so tenant isolation stays enforced server-side.
- Keep `GoogleService-Info.plist` environment-specific. Firebase client config is
  not a server secret, but committing production app config should be a deliberate
  release decision rather than an accidental local artifact.
- Use the stable error envelope and `requestId` for support/debugging instead of
  exposing raw backend errors to users.
- The app may initialize Firebase Auth now, but Backend must explicitly verify
  Firebase ID tokens before iOS can use them as the protected API credential.

iOS verification checklist:

- [ ] `rg "FirebaseApp.configure|Auth.auth" ios/GhostAgent`
- [ ] `rg "Firestore|FirebaseFirestore" ios/GhostAgent` returns no product-data
  access unless a new ADR approves it.
- [ ] `rg "UserDefaults.*token|print\\(.*token|debugPrint\\(.*token" ios/GhostAgent`
  returns no token persistence/logging.
- [ ] `xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' test`
