# ADR-0002 — Asynchronous GitHub ingest via Cloud Tasks

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** `functions/src/github.ts`, `functions/src/routes/projects.ts`, `firebase.json`, `functions/package.json` (Backend)

## Context

`ingestRepo` (`github.ts:53-121`) runs **synchronously inside the HTTP request**:
it walks up to `MAX_FILES = 200` blobs, fetches raw content, chunks, embeds in
batches of 20, and writes to Firestore — all before responding. The route
`POST /projects/:id/connect-github` (`routes/projects.ts`) awaits this.

Problems:

- Large repos risk the function **request timeout**, leaving `ingestStatus:"error"`
  and partial chunks.
- The user's HTTP request is held open for the entire ingest.
- No retry/backoff; a transient GitHub or embedding failure aborts the whole job.

## Decision

Move ingest to an **asynchronous job** driven by **Google Cloud Tasks**:

1. `POST /projects/:id/connect-github` validates ownership + input, sets
   `ingestStatus:"queued"`, enqueues a Cloud Task with `{ userId, projectId, repoUrl }`,
   and returns `202 Accepted` immediately.
2. A dedicated task-handler function performs `ingestRepo`, updating
   `ingestStatus` (`queued → running → done|error`) and progress fields.
3. The client polls project status (existing `GET /projects`) to show progress.

**Cloud Tasks** is chosen over **Pub/Sub** because ingest needs per-job
**rate control, retries with backoff, and long deadlines** (Tasks gives explicit
dispatch/retry config and a long task deadline), whereas Pub/Sub is tuned for
high-fanout streaming and has shorter ack windows. Pub/Sub remains a fallback if
we later need fan-out to multiple consumers.

## Consequences

- **Positive:** request returns fast; ingest survives long-running repos; built-in
  retries/backoff; partial-failure recovery via idempotent re-ingest (existing
  delete-then-write logic in `github.ts:68-79` is already idempotent).
- **Negative:** adds a queue + a second function (task handler) and IAM
  (`cloudtasks.enqueuer`); requires a status/progress contract addition; local
  emulation of Cloud Tasks is limited (document a synchronous fallback for the
  emulator in the RUNBOOK).
- **Contract impact:** add `ingestStatus` values (`queued|running|done|error`) and
  optional progress fields to the API; coordinate with Frontend via `CONTRACT.md`.

## Impact on files

- `functions/src/routes/projects.ts` — enqueue task + return `202`; stop awaiting
  ingest inline (Backend).
- `functions/src/github.ts` — expose `ingestRepo` as the task-handler body;
  add status/progress updates (Backend).
- `functions/package.json` — add `@google-cloud/tasks` (Backend).
- `firebase.json` — register the task-handler function if it needs distinct
  runtime options; otherwise no change (Architect reviews).
