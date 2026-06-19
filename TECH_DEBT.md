# TECH_DEBT.md

## Technical Debt Register (open items, sorted by ROI, highest first)

| # | Priority | Issue | Risk | Effort | ROI | Evidence |
|---|---|---|---|---|---|---|
| 1 | High | In-memory vector search (≤`VECTOR_CANDIDATE_CAP`, default 1500 docs/query) | Cost blowup, capped recall, latency | M-H | ★★★★★ | `memory.ts:32-65` |
| 2 | High | GitHub ingest synchronous in request | Timeouts, partial state | M-H | ★★★★ | `github.ts ingestRepo`, `routes/projects.ts:104-150` |
| 3 | Med | Session token in `localStorage` (XSS) | Token theft | M | ★★★★ | `app/api.ts:26-27`, `app/useGhostData.ts:80` |
| 4 | Med | Per-route rate limiter is in-memory only | Limits bypassable across instances | M | ★★★ | `ratelimit.ts:9-33` (login uses `consumeDistributed`) |
| 5 | Low/Med | CORS reflects all origins outside production | Broad exposure in non-prod | L | ★★★ | `index.ts:47-55` |
| 6 | Low | Env-key fallback on user-key decrypt failure | Surprise billing on env key | L | ★★ | `ai.ts:46-57` (now logged, not silent) |

## In-progress product debt (CONTRACT v2)

These are not regressions but surface area the contract freezes:

- **BUILD mode** service + endpoints are wired (`build.ts runBuild`,
  `routes/build.ts` with `POST /projects/:id/build`, `GET /builds`,
  `GET /builds/:id`, mounted in `index.ts`; `BuildSchema` +
  `build_runs`/`build_artifacts` indexes). Recently landed and under end-to-end
  verification (CONTRACT §v2.2).
- **Self-learning loop**, **skill schema v2**, and **deep ingest** are specified
  but not fully landed (CONTRACT §v2.3–v2.5).

## Resolved since the previous register (verified in code)

- GitHub PAT now encrypted at rest (`routes/projects.ts:96`, `crypto.ts`).
- Session tokens hashed + expiring + revocable (`auth.ts`, `routes/session.ts`).
- `/login` rate limited (`ratelimit.ts loginThrottle`).
- `.max()` bounds on all schemas, incl. API keys (`schemas.ts`).
- Batched embeddings, one call per batch (`ai.ts embeddingBatch`,
  `routes/sources.ts`).
- Seed users once per instance, not per login (`auth.ts ensureSeedUsersOnce`).
- `agent_logs` TTL field + `userId, createdAt` index (`util.ts`,
  `firestore.indexes.json`).
- Maintained dashboard counters instead of 8 `count()` per load (`stats.ts`,
  `routes/dashboard.ts`).
- Composite indexes populated; ordered listing with fallback (`listing.ts`).
- LRU-bounded provider client cache (`lru.ts`, `providers/*`).
- Coded `{ error, requestId }` envelope (`errors.ts`).
- Integration/route tests added (`functions/test/integration/**`).
- Root dependencies pinned to semver ranges (`package.json`).
- Frontend split into panels/components; the 1000-line single component is gone
  (`app/page.tsx` ~56 lines, `app/components/**`).

## Code smells / quality forensics

- Some `any` types remain in the AI/route layers; otherwise TS strictness is
  good.
- A shared `listScoped` helper now DRYs up the previous list-and-sort-in-memory
  duplication across routers (`listing.ts`).
- No dead code / circular deps detected in the reviewed modules; module
  boundaries are clean (`ai.ts` documents the deliberate avoidance of a circular
  import with `memory.ts`).
- `out/` build artifacts and `tsconfig.tsbuildinfo` exist in the working tree but
  are gitignored. `firestore-debug.log` was removed from the tree (gitignored).

## Dependency hygiene

- Root app pins deps to semver ranges (`package.json`); functions pin proper
  ranges too (`functions/package.json`). No `"latest"` pins remain.
