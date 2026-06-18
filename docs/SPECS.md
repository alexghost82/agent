# SPECS.md — Backend implementation specifications (text, not code)

> Architect-authored specifications for shared Backend primitives. These are
> **contracts/intent**, not implementations. Backend owns the code in
> `functions/src/**`; these specs constrain it so Frontend/QA can rely on stable
> behavior. See `CONTRACT.md` for the frozen wire-level seams.

---

## A. Typed Firestore converters

**Goal:** replace loosely-typed `doc.data()` access (currently `as` casts across
`memory.ts`, `dashboard.ts`, every route) with `FirestoreDataConverter<T>` per
collection, so reads/writes are type-checked and serialization is centralized.

**Spec:**

1. One TypeScript `interface` per collection document (`Topic`, `Source`,
   `KnowledgeChunk`, `AgentSkill`, `Project`, `ProjectDecision`, `GeneratedPlan`,
   `AgentLog`, `User`, `UserStats`). Every document type includes `userId: string`
   and `createdAt: Timestamp` (except singletons keyed by id).
2. For each, a `FirestoreDataConverter<T>` with:
   - `toFirestore(model)` — strips `id`, stamps server fields (`createdAt`,
     `expireAt` for `agent_logs` per ADR-0005), and never writes `undefined`
     (consistent with `db.settings({ ignoreUndefinedProperties: true })`).
   - `fromFirestore(snap)` — returns `{ id: snap.id, ...data }` typed as `T`.
3. A typed accessor `collection<T>(name)` returns
   `db.collection(name).withConverter(converterFor(name))` so call sites get `T`
   without casts.
4. Converters must **not** leak secret fields: the `User` read shape must exclude
   `passwordHash`, `sessionTokenHash`, and raw key material — expose only what
   routes are allowed to return (see API/CONTRACT).

**Impact:** `functions/src/firebase.ts` (or a new `converters.ts`), consumed by all
routes, `memory.ts`, `github.ts`. No wire/contract change.

---

## B. Shared `list + sort + scope` helper

**Goal:** every "list mine, newest first" route repeats the same pattern
(`where("userId","==",uid)` [+ optional `topicId`/`projectId`] +
`orderBy("createdAt","desc")` + `limit`). Centralize it so scoping (tenant
isolation) and ordering are applied **identically and unmissably**, and so it lines
up 1:1 with the composite indexes in `CONTRACT.md` §5.

**Spec — `listScoped<T>(collectionName, scope, opts)`:**

- `scope: { userId: string; topicId?: string; projectId?: string }` — `userId` is
  **mandatory**; the helper throws if it is empty (fail-closed isolation).
- Builds the query: `userId ==` first, then `topicId ==` / `projectId ==` when
  present, then `orderBy(opts.orderBy ?? "createdAt", opts.dir ?? "desc")`.
- `opts.limit` (default e.g. 50, hard max e.g. 200) — always bounded.
- Optional cursor (`startAfter`) for pagination; returns `{ items: T[], nextCursor? }`.
- Uses the typed converter (Spec A) so `items` are `T`.
- The set of `(collection, scope-fields, orderBy)` combinations the helper supports
  must be a **subset of the indexed combinations** in `CONTRACT.md` §5; adding a new
  combination requires a new index from Architect first.

**Impact:** new `functions/src/list.ts` (or in `util.ts`), used by `topics`,
`sources`, `skills`, `projects`, `design`, `plans`, and `dashboard` recent-logs.
Removes ad-hoc in-memory sorts (e.g. `dashboard.ts:31`).

---

## C. Typed errors (taxonomy + envelope)

**Goal:** make the error envelope in `CONTRACT.md` §1 unavoidable and consistent,
replacing `res.status(400).json({ error: err.message })` (e.g. `dashboard.ts:35`,
`skills.ts`) which leaks internal messages and uses unstable codes.

**Spec:**

1. A union type `ErrorCode = "unauthorized" | "validation_failed" | "not_found" |
   "rate_limited" | "no_api_key" | "ingest_failed" | "internal"` — **exactly** the
   taxonomy in `CONTRACT.md` §6. Adding a code is an Architect-gated contract change.
2. An `AppError` class: `new AppError(code, httpStatus, internalMessage?)`. The
   `code`→`httpStatus` mapping is fixed (Contract §6) and centralized so the two can
   never drift.
3. A single Express **error-handling middleware** (registered last) that:
   - if `err instanceof AppError` → responds `{ error: err.code, requestId }` with
     `err.httpStatus`;
   - otherwise → responds `{ error: "internal", requestId }` with `500`;
   - **always** logs the full `internalMessage`/stack via `log("error", ...)` with
     `requestId` (Contract §4). The raw message is never sent to the client.
4. Zod parse failures are converted to `AppError("validation_failed", 400)`; the
   detailed issues go to the log, not the response.
5. Routes `throw new AppError(...)` (or `next(err)`) instead of hand-rolling JSON,
   so every endpoint emits the identical envelope.

**Impact:** new `functions/src/errors.ts` + error middleware registered in
`functions/src/index.ts` (after routers); routes refactored to throw. This realizes
Contract §1 and §6 verbatim.

---

## Cross-references

- Wire contract & taxonomy → `CONTRACT.md` (§1, §6).
- Index coverage for Spec B → `CONTRACT.md` §5 / `firestore.indexes.json`.
- `expireAt` stamping for converters/logging → `adr/ADR-0005-agent-logs-ttl.md`.
- Counter increments referenced by Spec A/B write paths → `adr/ADR-0004-dashboard-counters.md`.

---

## D. iOS MVP client behaviour

**Goal:** make the native client usable against the existing backend without
changing the Firestore security model.

**Spec:**

1. The app boots through `FirebaseApp.configure()` and exposes Firebase
   configuration status in an internal diagnostics view.
2. The first shipped auth path uses the existing `POST /login` bearer session so
   it is compatible with current Cloud Functions. Firebase Auth is initialized
   and ready, but protected API migration to Firebase ID tokens is Backend-owned.
3. The bearer token is stored only in Keychain. It must never be logged, stored in
   `UserDefaults`, or included in screenshots/test fixtures.
4. Every protected request attaches `Authorization: Bearer <token>`.
5. Network responses decode either the expected success DTO or the stable error
   envelope `{ error, requestId }`.
6. Initial screens: signed-out login, dashboard summary, projects list, settings
   with API base/config diagnostics.

**Impact:** `ios/GhostAgent/**` (Frontend), `docs/API.md` (Architect/Backend
contract), and integration tests for auth/error handling (QA).
