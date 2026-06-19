# Implementation Plan — GHOST Agent Builder v2

Closing the gap between the product idea (learn → remember → skill → **build**,
with a self-learning loop) and the current code. The frozen seams for every item
below live in `docs/CONTRACT.md` (v2). Work is sequenced by file-zone ownership
so parallel agents never edit the same files at once.

## Phase 0 — Architecture (done)

- Froze v2 contracts in `docs/CONTRACT.md`: vector interface invariants +
  `contentHash` dedup, `build_runs`/`build_artifacts` model + endpoints, skill
  schema v2, self-learning loop, deep-ingest bounds, ownership.
- Added `build_runs` / `build_artifacts` composite indexes to
  `firestore.indexes.json`.

## Phase 1 — Real development core (done)

- `functions/src/build.ts` + `functions/src/routes/build.ts`: `POST /projects/:id/build`,
  `GET /builds`, `GET /builds/:id`. Generates real files from plan + skills +
  memory into a Firestore-backed sandbox; **never writes to GitHub**.
- `functions/src/pure.ts`: `sanitizeArtifactPath`, `detectLanguage`,
  `normalizeBuildFiles` (path safety + count/byte caps).
- Frontend Build step (`app/components/panels/BuildPanel.tsx`, `useGhostData.ts`,
  i18n EN/HE/RU): start a build, review files, download `.zip`, browse past runs.
- Tests: unit (pure helpers) + emulator integration (auth, ownership,
  `no_api_key`, cross-tenant isolation).

## Phase 2 — Depth, scale, hardening (next wave, sequential on `functions/src/**`)

1. **A4 — Memory & skills.** Move `memory.ts` to Firestore Vector Search
   (`findNearest`) behind the existing `VectorIndex` interface, keeping the
   in-memory cosine path as a tested fallback (emulator has no `findNearest`).
   Skill schema v2 extraction over the whole topic; design/plan/build read
   `template`/`appliesTo`.
2. **A3 — Deep ingest & self-learning.** Domain-bounded crawl (sitemap +
   same-origin links, page/depth caps), PDF support, `contentHash` dedup,
   write design/plan/build outcomes back into memory.
3. **A6 — Security.** Session token off `localStorage` (httpOnly cookie) or
   hardened CSP; `consumeDistributed` on `/ask /design /plan /learn /build`;
   security headers; user management; iOS ID-token verification.
4. **A5 — Scale & ops.** Async GitHub ingest via a queue with progress/retries;
   `scripts/` for seeding, TTL, backups; error tracking.
5. **A9 — Providers.** Add Anthropic + Azure OpenAI behind `providers/types.ts`;
   per-user usage accounting.
6. **A10 — iOS parity.** skills/design/plan/build flows, server-verifiable token,
   Keychain storage.

## Phase 3 — QA / Integration

- **A11.** End-to-end emulator test of the full path (deep learn → memory →
  skills v2 → project → design → plan → BUILD → feedback into memory), tenant
  isolation, limits, security. Frontend lint + coverage thresholds enforced in
  `.github/workflows/ci.yml`. Final readiness report.

## Global Definition of Done

1. Agent actually develops (generates files) from a plan — **closed in Phase 1**.
2. Deep resource study (crawl/PDF) + self-learning loop work.
3. Skills are applied; vector search is not bounded by the 1500 cap.
4. Async ingest, backups, TTL, error tracking enabled.
5. Security hardened; docs match code; CI green with the end-to-end test.

All work preserves existing endpoints, the error envelope, and per-`userId`
isolation, with minimal safe diffs.
