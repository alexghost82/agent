# GHOST Agent Builder — Readiness Report (MISSION FINAL)

Status against the final mission Definition of Done. Backend verified locally by
`tsc` (root) + `cd functions && npm run build` + `npm test` (all green; emulator
integration suites self-skip without Java), and on the **real** Firebase project
`agent-9d7c2` (Blaze) via the Firebase CLI/MCP. Date: 2026-06-19.

## Definition of Done

| # | Goal | Status | Evidence |
|---|---|---|---|
| 1 | BUILD really compiles/tests generated code in a sandbox | ✅ Done | `sandbox.ts` runs a real toolchain when `BUILD_EXEC_ENABLED=1` (`tsc`/eslint/`npm test` over generated files, sandboxed cwd, hard timeout, scrubbed env, `shell:false`, bounded logs) → results in `build_runs.verification`. Default stays static-only & never executes untrusted code. Tests: `functions/test/sandbox.test.ts` (9 tests incl. exec pass/fail/cleanup). |
| 2 | Async ingest, distributed limits, cookie sessions, user mgmt | ✅ Done | **Async ingest:** `connect-github` enqueues a Cloud Tasks job (`ingestWorker`, retries/backoff, idempotency token); deployed to `agent-9d7c2`. **Distributed limits:** `consumeDistributed` applied to `/ask /design /generate-plan /learn /build` (+ login throttle). **Cookies:** `httpOnly; Secure; SameSite=Strict` `gh_session` accepted alongside Bearer. **User mgmt:** roles (`admin`/`member`), admin invites + public `accept-invite`, `GET/PATCH /users`. Tests: `integration/ingest.test.ts`, `integration/usermgmt.test.ts`. |
| 3 | iOS on Firebase ID-token + web-workflow parity | ◑ In progress | Backend done & deployed: `verifyFirebaseIdToken` + `POST /auth/firebase` (verified live). iOS parity (build/memory panels, `queued` ingest state, Firebase sign-in + Keychain, Swift tests, Firebase SDK via xcodegen) is being completed by a dedicated sub-agent on `ios/` — see its report for the xcodebuild/test result. |
| 4 | Deployed on real `agent-9d7c2` (Blaze) | ✅ Done (AI keys + TTL/backups pending owner) | DB ✅, functions `api`+`ingestWorker` ✅, rules ✅, hosting ✅ (https://agent-9d7c2.web.app), vector composite indexes created (dim 1536). **Pending owner action:** AI keys (none available at deploy → `readiness.ai:false`), and TTL/backup scripts (need `gcloud auth`). See RUNBOOK §12. |
| 5 | Integration green on CI; e2e on real project | ◑ Mostly | CI runs unit + emulator integration (Java 17) + coverage gate + secret scan + conditional frontend lint/tests. Live e2e on `agent-9d7c2`: login→project CRUD→isolation(401)→admin users/invites→logout **verified**. The AI-dependent e2e leg (deep-learn→ask→design→plan→BUILD) is blocked only by missing AI keys. |

## Live verification on agent-9d7c2 (this wave)

```
GET  /api/health     → {"ok":true,"version":"ghost-2.0"}
GET  /api/readiness  → 503 {"firestore":true,"ai":false}   # ai false = no key set
POST /api/login      → 200 {ok,token,user:{role:"admin"}}    # + httpOnly gh_session
POST /api/projects   → 200 {id,status:"created"}             # authed CRUD
GET  /api/projects   → 200 {projects:[...]}                  # owner-scoped
GET  /api/projects   → 401 (no token)                        # isolation
GET  /api/users      → 200 (admin only; no secrets leaked)   # roles
POST /api/invites    → 200 {code,...}                        # invites
POST /api/logout     → 200 {ok:true}
```

Security headers confirmed on responses (CSP `default-src 'none'`, HSTS,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CORP).

## What runs where

- **Local:** `tsc` + functions build + unit tests — green (83 passed; integration
  self-skips without Java).
- **CI (`.github/workflows/ci.yml`):** `checks` (typecheck, conditional frontend
  lint, `test:web`, functions build+test) · `integration` (Java 17 Firestore
  emulator `emulators:exec` + v8 coverage thresholds) · `secret-scan`.
- **Production (`agent-9d7c2`):** Hosting + `api` + `ingestWorker`, Firestore
  Native, deny-all rules, vector indexes, `VECTOR_BACKEND=firestore`.

## Remaining owner actions (cannot be done from this environment)

1. **AI keys** — set `OPENAI_API_KEY` / `GEMINI_API_KEY` in
   `functions/.env.agent-9d7c2` and redeploy functions (or enter a per-user key in
   Settings). Rotate any previously committed/compromised key. Unblocks the full
   AI e2e.
2. **TTL + backups** — run `scripts/enable-ttl.sh` and `scripts/backup.sh` from a
   `gcloud auth login` shell (Firebase CLI token alone is insufficient).
3. **Confirm vector indexes `READY`** — `firebase firestore:indexes` (they were
   `CREATING` immediately after creation; build is fast on an empty collection).

## Notes / deferrals

- `findNearest` requires the composite vector indexes (filter field + `embedding`)
  — created here; the single-field override alone does not serve the `userId`-
  filtered query. Reproducible via `firestore.indexes.json`.
- The Firestore emulator can't exercise `findNearest`; the in-memory cosine
  backend remains the CI-tested path, with the `firestore` backend smoke-tested
  against the real project once AI keys + data exist.
