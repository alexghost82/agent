# TECH_DEBT.md

## Technical Debt Register (sorted by ROI, highest first)

| # | Priority | Issue | Risk | Cost of Delay | Effort | ROI | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | High | In-memory vector search (≤1500 docs/query) | Cost blowup, capped recall, latency | High | M-H | ★★★★★ | `memory.ts:24-45` |
| 2 | High | GitHub PAT stored plaintext | Secret leak | High | L | ★★★★★ | `projects.ts:79,99` |
| 3 | High | Session tokens never expire / no revoke | Durable account takeover | High | L-M | ★★★★★ | `auth.ts:67`, `public.ts:25` |
| 4 | High | `/login` not rate limited | Brute force | High | L | ★★★★★ | `public.ts:14` |
| 5 | High | GitHub ingest synchronous in request | Timeouts, partial state | Med-High | M-H | ★★★★ | `github.ts:84-111` |
| 6 | Med | No `.max()` bounds on inputs/keys | Cost abuse / DoS | Med | L | ★★★★ | `schemas.ts:58-62`, `test/keys.test.ts:255` |
| 7 | Med | One embedding HTTP call per chunk | Latency/cost | Med | M | ★★★ | `sources.ts:56`, `github.ts:90` |
| 8 | Med | `ensureSeedUsers()` every login | Extra reads/latency | Low-Med | L | ★★★★ | `public.ts:17` |
| 9 | Med | `agent_logs` unbounded, no TTL/index | Storage growth, slow lists | Med | M | ★★★ | `util.ts:14`, `dashboard.ts:28` |
| 10 | Med | In-memory rate limiter only | Limits bypassable | Med | M | ★★★ | `ratelimit.ts:5-6` |
| 11 | Med | No route/integration tests | Regressions in auth/isolation | Med | M | ★★★ | `functions/test/*` (unit only) |
| 12 | Low | CORS reflects all origins by default | Broad exposure | Low-Med | L | ★★★ | `index.ts:42-47` |
| 13 | Low | Verbose `err.message` to client | Info leak | Low | L | ★★★ | `ask.ts:19` et al. |
| 14 | Low | Silent decrypt-failure fallback to env key | Masked tampering, surprise billing | Low | L | ★★ | `ai.ts:33-39` |
| 15 | Low | Provider client cache unbounded | Slow memory growth | Low | L | ★★ | `providers/openai.ts:5` |
| 16 | Low | `page.tsx` 1153-line single component | Maintainability | Low | M | ★★ | `app/page.tsx` |
| 17 | Low | `firestore.indexes.json` empty; in-memory sorts everywhere | Scales poorly | Low-Med | M | ★★ | `firestore.indexes.json`, `topics.ts:13` |
| 18 | Low | `"latest"` pinned root deps | Non-reproducible builds | Low-Med | L | ★★★ | `package.json:15-28` |

## Code smells / quality forensics

- **`any` types in routes/AI layer** (`ai.ts:66 context: any[]`, many `err: any`) reduce type safety; otherwise TS strictness is good.
- **Duplication:** the list-and-sort-in-memory pattern repeats across `topics.ts`, `sources.ts`, `skills.ts`, `projects.ts`, `design.ts`, `plans.ts` — a shared helper would DRY it up.
- **Duplicate skill-fetch logic** between `design.ts:13-20` and `plans.ts:39-45`.
- **No dead code / circular deps detected** in the reviewed modules; module boundaries are clean.
- **Frozen contract is well done** (`providers/types.ts`) and enforced by type tests — a positive, not debt.
- **`out/` build artifacts and `tsconfig.tsbuildinfo` present in working tree** but gitignored; `firestore-debug.log` present locally and gitignored (not committed).

## Dependency hygiene
- Root app pins every dependency to `"latest"` (`package.json:15-28`) — reproducibility/supply-chain risk. Functions pin proper semver ranges (`functions/package.json`). Recommend pinning root deps.
