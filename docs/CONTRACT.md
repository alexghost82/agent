# CONTRACT.md — GHOST Integration Contract (§1, FROZEN)

> **Status:** FROZEN. Version `1.0.0`. Owner: **Architect**.
> Changes to this contract may be made **only by the Architect** and must be
> propagated to Backend, Frontend, and QA. This is the single source of truth for
> the seams between the four parallel missions (Architect / Backend / Frontend / QA).

This document formalizes §1 ("Контракт интеграции") of the orchestrator plan. It
defines the stable interfaces every agent depends on so they can work without
blocking each other.

---

## 1. Error envelope (Backend ↔ Frontend)

Every non-2xx JSON response uses exactly this shape:

```json
{ "error": "<stable_code>", "requestId": "<id>" }
```

Rules:

- `error` is a **stable machine code**, never `err.message`. See the taxonomy in
  [§6 Error taxonomy](#6-error-taxonomy-stable-codes).
- The full human-readable error text and stack go to the **server log only**,
  correlated by `requestId`.
- HTTP status codes are preserved and meaningful:
  - `400` → `validation_failed`
  - `401` → `unauthorized`
  - `404` → `not_found`
  - `429` → `rate_limited`
  - `500` → `internal`
- Frontend switches on `error` (the code), not on status text or message.

> **Migration note (Backend):** current routes return `{ error: err.message }`
> (e.g. `routes/dashboard.ts:35`). Backend must move to the coded envelope above
> and log the raw message with `requestId`.

---

## 2. Session model (`users/{id}` document)

Fields stored on the user document:

| Field | Type | Meaning |
|---|---|---|
| `sessionTokenHash` | `string` (sha256 hex of the raw token) | Lookup key for `requireAuth`. |
| `sessionExpiresAt` | `Timestamp` | Hard expiry; expired tokens are rejected. |
| `sessionUpdatedAt` | `Timestamp` | Last issue/refresh time. |

Rules:

- The **raw token is never stored** in Firestore. Only its sha256 hash is stored.
- `POST /login` still returns `{ ok, token, user }`; the **raw token appears only
  in that response body**, and the client persists it locally.
- `requireAuth` hashes the incoming `Authorization: Bearer <token>`, looks the
  user up by `sessionTokenHash`, and rejects if `sessionExpiresAt` has passed
  (→ `401 unauthorized`).
- New `POST /logout` (under `requireAuth`) clears `sessionTokenHash`,
  `sessionExpiresAt`, and `sessionUpdatedAt`.

> **Index dependency:** lookup by `sessionTokenHash` is an equality query on a
> single field, which Firestore serves with the automatic single-field index — no
> composite index required.

---

## 3. Health / Readiness

| Endpoint | Auth | Response | Purpose |
|---|---|---|---|
| `GET /health` | public | `{ ok, version }` | Liveness. Must stay cheap and dependency-free. |
| `GET /readiness` | public | `{ ok, checks: { firestore, ai } }` | Pings Firestore and verifies AI configuration is present. |

`/readiness` returns `ok: false` (HTTP `503`) if any check fails, with the
per-check booleans in `checks`.

---

## 4. Structured logging

- A middleware sets `req.requestId` from the inbound `X-Request-Id` header, or
  generates one (uuid/hex) when absent. The `requestId` is echoed in every error
  envelope (§1).
- A helper `log(level, event, fields)` writes a **single-line JSON** record to
  stdout. Every record includes at minimum: `level`, `event`, `requestId`, and
  (when authenticated) `userId`.
- Levels: `"debug" | "info" | "warn" | "error"`.
- No secrets, raw tokens, API keys, or full request bodies are logged.

---

## 5. Required Firestore composite indexes

Architect owns these in `firestore.indexes.json`. Backend relies on them for
`where(...).orderBy("createdAt","desc").limit(...)` queries. (All `userId`
filters are equality.)

| Collection | Fields (in order) |
|---|---|
| `topics` | `userId ==`, `createdAt desc` |
| `sources` | `userId ==`, `createdAt desc` |
| `sources` | `userId ==`, `topicId ==`, `createdAt desc` |
| `projects` | `userId ==`, `createdAt desc` |
| `project_decisions` | `userId ==`, `projectId ==`, `createdAt desc` |
| `generated_plans` | `userId ==`, `projectId ==`, `createdAt desc` |
| `agent_logs` | `userId ==`, `createdAt desc` |
| `agent_skills` | `userId ==`, `topicId ==`, `createdAt desc` |

Backend must not change ordering or add new `orderBy` queries that need an index
without requesting the matching index from Architect.

---

## 6. Error taxonomy (stable codes)

These are the only codes Frontend may switch on. Backend may add new codes **only
via Architect** (update this section + notify Frontend/QA).

| Code | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | Missing/invalid/expired session token. |
| `validation_failed` | 400 | Zod schema rejected the request body/query. |
| `not_found` | 404 | Resource missing or not owned by the caller. |
| `rate_limited` | 429 | Per-user/route limiter tripped. |
| `no_api_key` | 400 | No usable AI key (neither user nor server). |
| `ingest_failed` | 400 | GitHub ingest could not complete. |
| `internal` | 500 | Unhandled/unexpected server error. |

`not_found` is deliberately returned for "exists but not owned by caller" to avoid
leaking the existence of other tenants' resources.

---

## 7. Cold-start / runtime configuration (Backend handoff)

`minInstances` and `concurrency` for the `api` function are **runtime options of a
Gen2 callable/HTTPS function** and are configured **in code**, not in
`firebase.json`. The frozen target values are:

| Option | Value | Reason |
|---|---|---|
| `minInstances` | `1` | Keep one warm instance to eliminate user-facing cold starts. |
| `concurrency` | `80` | Allow request multiplexing per instance (Gen2 default range). |
| `memory` | `512MiB` | Headroom for in-memory vector scan (`memory.ts`) until ADR-0001 lands. |

**Backend action:** apply these via `setGlobalOptions({ minInstances, concurrency, memory })`
or the `onRequest({ ... })` options object in `functions/src/index.ts:72`. Architect
owns the *values* (this table); Backend owns the *code*.

---

## 8. File ownership (anti-conflict)

| File / zone | Owner |
|---|---|
| `functions/src/**` (all logic) | Backend |
| `functions/src/schemas.ts` | Backend (edits), QA (reads/tests) |
| `app/**` | Frontend |
| `firestore.indexes.json`, `firebase.json`, `firestore.rules` | Architect |
| root `package.json` (version pinning) | Architect |
| `functions/package.json` (new backend deps) | Backend |
| `.github/workflows/ci.yml` | QA |
| `functions/test/**` | QA |
| `docs/**`, `README.md`, ADRs, runbook, `*_REPORT.md` | Architect |

---

## 9. iOS client contract

The iOS client is a native SwiftUI app in `ios/GhostAgent` with bundle id
`com.ghostagnt.ghost`. It connects to the same Firebase project as this backend.

Rules:

- Firebase config is supplied by `GoogleService-Info.plist`, retrieved with
  `npx -y firebase-tools@latest apps:sdkconfig IOS <APP_ID> --project <PROJECT_ID>`.
- The checked-in app may include templates and documentation, but real local
  config values should be treated as environment-specific.
- Product data access stays server-mediated: iOS calls Cloud Functions HTTPS API
  endpoints and does not read or write Firestore directly.
- Authenticated API calls send `Authorization: Bearer <token>`. The current
  backend token is returned by `POST /login`; Firebase Auth ID tokens are the
  target mobile auth transport and require a Backend-owned compatibility step
  before replacing the session token on protected routes.
- iOS decoders must support the stable error envelope from §1:
  `{ "error": "<stable_code>", "requestId": "<id>" }`.

Minimum iOS API surface:

|Flow|Endpoint|Auth|iOS expectation|
|---|---|---|---|
|Liveness|`GET /health`|public|Render backend availability.|
|Session login|`POST /login`|public|Store returned bearer token in Keychain.|
|Session logout|`POST /logout`|bearer|Clear token and return to signed-out state.|
|Dashboard|`GET /dashboard`|bearer|Decode counts and recent logs.|
|Projects|`GET /projects`|bearer|Decode current user's project list.|

---

---

# CONTRACT v2 — Product completion (learn → remember → skill → BUILD)

> **Status:** FROZEN. Version `2.0.0`. Owner: **Architect**.
> v2 adds the seams required to close the core product gap: the agent must
> actually **develop** (generate real project files) from a plan, study resources
> **deeply**, scale memory, and **learn from its own outcomes**. These interfaces
> are stable so the mission agents (A2–A11) can work without blocking each other.
> Everything in v1 (§1–§9) remains in force and unchanged.

## v2.1 Vector search interface (owner: A4 — `functions/src/memory.ts`)

The `VectorIndex` seam already exists and **must not change shape**:

```ts
interface SearchScope { userId: string; topicId?: string; projectId?: string }
interface ScoredChunk {
  id: string; sourceUrl?: string; sourcePath?: string; title?: string;
  content: string; chunkType?: string; scope?: string; score: number;
}
interface VectorIndex {
  search(query: string, scope: SearchScope, limit: number): Promise<ScoredChunk[]>;
}
export function searchMemory(query: string, scope: SearchScope, limit?: number): Promise<ScoredChunk[]>;
```

Invariants (frozen):

- **`userId` scope is mandatory** on every search and every read of
  `knowledge_chunks`. `topicId`/`projectId` only narrow further.
- Callers depend on `searchMemory(query, scope, limit)` and **must not** know
  whether the backing store is in-process cosine (current) or Firestore
  `findNearest` (ADR-0001 target). A4 may swap the implementation **behind this
  interface only**.
- The `VECTOR_CANDIDATE_CAP` env (default `1500`) governs the in-memory fallback
  only. When `findNearest` lands, recall is no longer bounded by this cap; the
  cap var stays read for the fallback path. A4 owns `firestore.indexes.json`
  vector field overrides via Architect.
- `knowledge_chunks` document shape is frozen for writers (ingest, learn, build
  feedback): `{ userId, scope: "topic"|"project"|"build", topicId?, projectId?,
  sourceUrl?, sourcePath?, title, content, embedding: number[], chunkType,
  confidence, contentHash?, createdAt }`. `contentHash` (sha256 of normalized
  content) is the **dedup key** (A3): writers skip a chunk whose
  `(userId, scope, topicId|projectId, contentHash)` already exists.

## v2.2 Build / execution contract (owner: A2 — `functions/src/build.ts`, `functions/src/routes/build.ts`)

The agent **generates real files** into an isolated Firestore-backed workspace.
It is a sandbox: artifacts live only in Firestore under the owner's `userId` and
are downloaded client-side (`app/zip.ts`). **It NEVER writes to GitHub** and never
mutates any external repo; GitHub ingest stays strictly read-only (v1).

### Collections (Architect owns indexes)

`build_runs/{id}`:

| Field | Type | Notes |
|---|---|---|
| `userId` | string | Owner. Mandatory isolation key. |
| `projectId` | string | Owning project (must be owned by `userId`). |
| `projectName` | string | Denormalized for listing. |
| `planId` | string \| null | Source `generated_plans` doc (owned), if any. |
| `instructions` | string \| null | Extra build instructions. |
| `status` | `"running" \| "ready" \| "error"` | Lifecycle. |
| `fileCount` | number | Number of artifacts produced. |
| `summary` | string | Short human summary of what was built. |
| `errorCode` | string \| null | Stable error code when `status==="error"`. |
| `createdAt` / `updatedAt` | Timestamp | |

`build_artifacts/{id}`:

| Field | Type | Notes |
|---|---|---|
| `userId` | string | Owner. Mandatory isolation key. |
| `buildRunId` | string | Parent run. |
| `projectId` | string | Denormalized. |
| `path` | string | Relative file path (no leading `/`, no `..`). |
| `content` | string | File contents (text). |
| `language` | string \| null | Best-effort language tag from extension. |
| `bytes` | number | `content` byte length. |
| `createdAt` | Timestamp | |

### Endpoints (all under `requireAuth`, error envelope §1)

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/projects/:id/build` | `{ planId?, instructions?, lang? }` | `{ id, status, files: [{path,content}], summary, fileCount }` |
| `GET` | `/builds?projectId=<id>` | — | `{ runs: BuildRun[] }` (scoped, newest first) |
| `GET` | `/builds/:id` | — | `{ run: BuildRun, artifacts: BuildArtifact[] }` (owned) |

Rules (frozen):

- Ownership: `:id` project and any `planId` must belong to the caller, else
  `404 not_found` (never leak existence).
- Rate limit: `rateLimit("build", 6, 60_000)` (expensive, multi-file LLM).
- `no_api_key` (400) when no usable AI key, exactly like design/plan.
- Artifact `path` is sanitized: leading slashes stripped, `..` segments rejected,
  capped count (`BUILD_MAX_FILES`, default 40) and per-file size
  (`BUILD_MAX_FILE_BYTES`, default 100_000).
- Generated artifacts are surfaced for **review/download only**; nothing is
  applied to any user repo. Frontend (A7) downloads via `app/zip.ts`.

## v2.3 Skill schema v2 (owner: A4 — `functions/src/routes/skills.ts`, `schemas.ts`)

`agent_skills/{id}` superset (backward compatible — old docs still valid):

| Field | Type | Notes |
|---|---|---|
| `skillName` / `description` / `example` | string | v1 fields (kept). |
| `appliesTo` | string[] | Tags/stacks the skill applies to (e.g. `["nextjs","firestore"]`). |
| `template` | string \| null | Reusable, parameterizable snippet/pattern the build step can apply. |
| `version` | number | Schema/content version; defaults `1` for legacy. |
| `quality` | `{ score: number; rationale?: string }` \| null | Validation of the extracted skill. |
| `memoryType` | `"procedural"` | Unchanged. |

Extraction (A4) draws from the **whole topic** (not a fixed 16-chunk slice) and
records `version`/`appliesTo`/`template`/`quality`. Build (A2) and design/plan
read `template`/`appliesTo` to actually influence generation.

## v2.4 Self-learning loop (owner: A3 — `functions/src/learn.ts` / feedback writer)

Outcomes of design/plan/build are written back into memory as new
`knowledge_chunks` with `scope:"build"` (or `"project"`), `chunkType` one of
`"design_outcome" | "plan_outcome" | "build_outcome"`, the same dedup
(`contentHash`) and `userId`/`projectId` scoping. This is **additive**: a failed
or low-value outcome may be skipped, but a stored outcome is retrievable by
`searchMemory` for subsequent design/plan/build calls. No write crosses tenants.

## v2.5 Deep ingest (owner: A3 — `functions/src/ssrf.ts`, `routes/sources.ts`)

`/learn` may study a resource **deeply** within strict bounds:

- Domain-bounded crawl: same-origin only, follows `sitemap.xml` + in-page links,
  capped by `INGEST_MAX_PAGES` (default 20) and `INGEST_MAX_DEPTH` (default 2).
- PDF extraction supported; optional headless render is behind a flag and
  off by default.
- Per-page byte cap stays finite (raise the current 160k cautiously); total work
  bounded by page count × per-page cap.
- Dedup by `contentHash` so re-`/learn` of the same URL does not duplicate chunks.
- SSRF guards (private-IP/redirect checks) from v1 apply to **every** fetched URL.

## v2.6 Updated ownership (supersedes §8 for new files)

| File / zone | Owner |
|---|---|
| `functions/src/build.ts`, `functions/src/routes/build.ts` | A2 (Backend) |
| `functions/src/memory.ts` | A4 (Backend) |
| `functions/src/ssrf.ts`, `functions/src/learn.ts`, `routes/sources.ts` | A3 (Backend) |
| `functions/src/routes/skills.ts` | A4 (Backend) |
| `functions/src/github.ts`, async ingest queue, `scripts/**` | A5 (Backend/Ops) |
| security middleware, `routes/session.ts`, CSP | A6 (Backend) |
| `functions/src/providers/**` | A9 (Backend) |
| `app/**` | A7 (Frontend) |
| `ios/**` | A10 (iOS) |
| `functions/test/**`, `.github/workflows/ci.yml` | A11 (QA) |
| `firestore.indexes.json`, `firestore.rules`, `docs/**`, root `*.md` | Architect (A8 executes doc content) |

Backend agents touching `functions/src/index.ts` (router wiring) and
`functions/src/schemas.ts` coordinate through the Architect: append-only, one
router/schema block per agent, never reorder existing wiring.

## Changelog

- `2.0.0` — v2 contracts: vector interface invariants + `contentHash` dedup,
  build/execution model (`build_runs`/`build_artifacts` + endpoints, sandbox =
  Firestore workspace, never writes GitHub), skill schema v2, self-learning loop,
  deep ingest bounds, updated ownership for new files.
- `1.1.0` — Add iOS client contract, bundle id, Firebase config workflow, and
  mobile API expectations.
- `1.0.0` — Initial freeze of §1 (error envelope, session model, health/readiness,
  structured logging, composite indexes, error taxonomy, cold-start config, ownership).
