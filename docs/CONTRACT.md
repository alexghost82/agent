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

## Changelog

- `1.1.0` — Add iOS client contract, bundle id, Firebase config workflow, and
  mobile API expectations.
- `1.0.0` — Initial freeze of §1 (error envelope, session model, health/readiness,
  structured logging, composite indexes, error taxonomy, cold-start config, ownership).
