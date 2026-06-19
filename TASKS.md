# TASKS.md — Work Tracker

Status of the GHOST Agent Builder 2.0 product-completion work. Items are verified
against the code; see `ROADMAP.md` for sequencing and effort, and
`docs/CONTRACT.md` for the frozen seams.

## Done (verified in code)

- [x] Stable error envelope `{ error, requestId }` with server-only detail
  (`functions/src/errors.ts`).
- [x] Session model: store only `sessionTokenHash`, hard `sessionExpiresAt`,
  rotate on login, server-side `/logout` (`auth.ts`, `routes/public.ts`,
  `routes/session.ts`).
- [x] `/login` throttling (per-IP + per-username) via distributed limiter
  (`ratelimit.ts` `loginThrottle` / `consumeDistributed`).
- [x] Per-user provider API keys encrypted at rest, AES-256-GCM (`crypto.ts`);
  GitHub PAT also encrypted with legacy-plaintext read fallback
  (`routes/projects.ts`).
- [x] Input bounds (`.max()`) on all zod schemas, including API keys
  (`schemas.ts`).
- [x] Batched embeddings — one provider call per batch (`ai.ts embeddingBatch`,
  `routes/sources.ts`).
- [x] Seed users once per instance, not per login (`auth.ts ensureSeedUsersOnce`).
- [x] Maintained per-user counters for the dashboard instead of 8 `count()`
  queries (`stats.ts`, `routes/dashboard.ts`).
- [x] Composite indexes + ordered listing with in-memory fallback
  (`firestore.indexes.json`, `listing.ts`).
- [x] `agent_logs` TTL field (`util.ts expireAt`) + `userId, createdAt` index.
- [x] LRU-bounded provider client cache (`lru.ts`, `providers/*`).
- [x] Pinned root dependencies (semver ranges in `package.json`).
- [x] Frontend split into panels/components (`app/components/**`,
  `app/components/panels/**`) — the monolithic page is gone.
- [x] Health/readiness probes (`GET /health`, `GET /readiness`).
- [x] Integration tests per router against the Firestore emulator
  (`functions/test/integration/**`) + CI coverage gate and secret scan.

## In progress / landing (CONTRACT v2)

- [~] **BUILD mode** — real file generation into `build_runs` / `build_artifacts`.
  The service and endpoints are wired: `runBuild` (`functions/src/build.ts`),
  `POST /projects/:id/build`, `GET /builds`, `GET /builds/:id`
  (`functions/src/routes/build.ts`, mounted in `index.ts`), plus `BuildSchema`
  and Firestore indexes. Artifacts stay in Firestore — never written to GitHub
  (CONTRACT §v2.2). _(Recently landed via the parallel backend mission;
  end-to-end verification ongoing.)_
- [ ] **Self-learning loop** — write design/plan/build outcomes back into memory
  as `knowledge_chunks` with `build`/`project` scope (CONTRACT §v2.4).
- [ ] **Skill schema v2** — `appliesTo` / `template` / `version` / `quality`,
  extracted from the whole topic (CONTRACT §v2.3).
- [ ] **Deep ingest** — domain-bounded crawl, PDF extraction, `contentHash`
  dedup (CONTRACT §v2.5).

## Remaining gaps (see TECH_DEBT / PERFORMANCE / SECURITY reports)

- [ ] Replace in-memory cosine search with a real vector index; recall is capped
  at `VECTOR_CANDIDATE_CAP` (default 1500) (`memory.ts`).
- [ ] Make GitHub ingest asynchronous — it currently runs fully inside the
  request and risks the function timeout on large repos (`routes/projects.ts`,
  `github.ts`).
- [ ] Move the session token off `localStorage` (XSS exposure) toward
  httpOnly-cookie or short-lived tokens (`app/api.ts`).
- [ ] Extend the distributed limiter to expensive AI endpoints (today the
  per-route limiter is in-memory; only login uses the distributed one).

## Cross-cutting

- [ ] Keep docs aligned with code as v2 features land (this file, `ROADMAP.md`,
  the `*_REPORT.md` files).
- [ ] Add tests alongside each new v2 feature under `functions/test/**`.
