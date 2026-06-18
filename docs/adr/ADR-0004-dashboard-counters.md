# ADR-0004 — Dashboard counters vs `count()` ×8

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** `functions/src/routes/dashboard.ts`, write paths in `functions/src/routes/**` and `functions/src/github.ts`

## Context

`GET /dashboard` (`routes/dashboard.ts:19-37`) issues **eight parallel aggregation
queries** — one `count()` per collection in `COUNT_COLLECTIONS` (`dashboard.ts:8-17`)
— on every dashboard load. Firestore `count()` is billed per **read unit batch**
(roughly one read per up-to-1000 index entries scanned), so for active users this
is repeated, growing cost on a screen that is hit frequently. It also issues a 9th
query for recent logs.

## Decision

Maintain a **per-user denormalized counters document** `user_stats/{userId}` with a
field per collection (`topics`, `sources`, `knowledge_chunks`, `agent_skills`,
`projects`, `project_decisions`, `generated_plans`, `agent_logs`). Counters are
updated with `FieldValue.increment(±1)` in the same write path that creates/deletes
the underlying document (ideally in the same batch/transaction). `GET /dashboard`
then becomes a **single document read** plus the recent-logs query.

We **reject** keeping `count()` ×8 because cost scales with both usage frequency and
collection size. We **reject** Firestore's distributed-counter sharding for these
fields because per-user write rates are far below the ~1 write/sec single-document
ceiling; plain `increment` is sufficient. Add sharding later only if a specific
counter becomes hot.

## Consequences

- **Positive:** dashboard cost drops from ~8 aggregation queries to 1 doc read;
  predictable, O(1) latency.
- **Negative:** counters must be updated on **every** create/delete path; a missed
  update causes drift. Mitigations: (a) centralize increments in the shared
  list/scope helper / converters (see `docs/SPECS.md`), (b) provide a
  `recompute` admin path that rebuilds `user_stats` from `count()` to self-heal,
  (c) treat batch/transaction failures as all-or-nothing so the counter and the
  document move together.

## Impact on files

- `functions/src/routes/dashboard.ts` — read `user_stats/{userId}` instead of 8×
  `count()` (Backend).
- All create/delete sites (e.g. `routes/topics.ts`, `routes/sources.ts`,
  `routes/skills.ts`, `routes/projects.ts`, `routes/design.ts`, `routes/plans.ts`,
  `github.ts` chunk writes/deletes) — increment/decrement the matching field in the
  same batch (Backend).
- `firestore.indexes.json` — none (single-doc reads).
