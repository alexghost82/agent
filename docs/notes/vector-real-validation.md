# Real Firestore Vector Search validation

This note explains how we validate the **Firestore Vector Search** backend
(`FirestoreVectorIndex.search` → `findNearest`) against a **real** Firebase
project, why the emulator can't do it, and how to run it locally and in CI.

## Why the emulator can't validate `findNearest`

`FirestoreVectorIndex` (in `functions/src/memory.ts`) issues a
`findNearest({ vectorField: "embedding", queryVector, limit, distanceMeasure: "COSINE" })`
query. **The Firestore emulator does not implement `findNearest`.** Because of
that:

- `makeIndex()` deliberately auto-selects the in-memory cosine backend under the
  emulator (`isEmulator()` → `memory`), and
- the emulator integration suite
  (`functions/test/integration/vector_backend.test.ts`) can only assert the
  **fallback** path (a simulated `findNearest` failure degrades to in-memory
  cosine scoring).

So the *actual* vector query — index usage, COSINE distance, nearest-neighbour
ordering, and embeddings stored as native Firestore vector values
(`FieldValue.vector`) — is **never exercised** by normal CI. The only way to
validate it is to run against a real project that has the vector index deployed.

## What the real validation does

`functions/test/integration-real/vector_real.test.ts`:

1. **Self-skips** unless pointed at a real test project (see gating below) and
   refuses to run if a `FIRESTORE_EMULATOR_HOST` is set.
2. Forces `VECTOR_BACKEND=firestore` before importing `memory.ts`.
3. Seeds three deterministic `knowledge_chunks` (`near`/`mid`/`far`) under a
   throwaway `ghost_vec_real_*` userId, with orthogonal unit embeddings stored as
   `FieldValue.vector` (dimension **1536**, matching `firestore.indexes.json`).
4. **Mocks only the embedding provider** so the query vector is fixed and free;
   the real `findNearest` query is **not** mocked.
5. Calls `searchMemory(...)` and asserts the cosine nearest-neighbour ordering is
   `near > mid > far` with strictly decreasing similarity scores.
6. Deletes all seeded docs in `afterAll`. **No real user data is ever touched.**

The seed/cleanup logic lives in `functions/scripts/seed-vector-fixtures.ts` and
is reusable + runnable standalone (see below).

## Test project + secrets setup

1. Create a **disposable** Firebase project (e.g. `ghost-vector-test`). Do not
   point this at production.
2. Deploy the vector index (the workflow does this automatically, or run it once
   manually):

   ```bash
   firebase deploy --only firestore:indexes --project <TEST_PROJECT>
   ```

   The relevant index/fieldOverride for `knowledge_chunks.embedding` (dim 1536)
   is already declared in `firestore.indexes.json`.
3. Create a service account with Firestore access and download its JSON key.
4. Configure these **repo secrets** for the `vector-validation` workflow:

   | Secret | Purpose |
   | --- | --- |
   | `FIREBASE_TOKEN` | `firebase login:ci` token used by `firebase deploy`. |
   | `GHOST_TEST_PROJECT` | The test project id. |
   | `GHOST_TEST_SA_KEY` | Service-account JSON; used as `GOOGLE_APPLICATION_CREDENTIALS` at runtime and to authenticate `gcloud` for the index-READY poll. |

## Running locally

```bash
cd functions
export GHOST_VECTOR_REAL=1
export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/sa.json
export GCLOUD_PROJECT=<TEST_PROJECT>          # or FIREBASE_PROJECT
export VECTOR_BACKEND=firestore               # also forced by the test
npx vitest run test/integration-real/vector_real.test.ts
```

The index must already be deployed **and built (READY)** on the test project.

Manual seed/cleanup (independent of the test) via the standalone helper:

```bash
# seed (prints the generated userId)
GHOST_VECTOR_REAL=1 GOOGLE_APPLICATION_CREDENTIALS=./sa.json GCLOUD_PROJECT=<TEST_PROJECT> \
  npx tsx scripts/seed-vector-fixtures.ts seed

# cleanup
... npx tsx scripts/seed-vector-fixtures.ts cleanup <userId>
```

Without `GHOST_VECTOR_REAL=1` (or with an emulator host set), the test simply
self-skips — this is what keeps the default `npm test` and the emulator CI job
green.

## Running via the workflow

`.github/workflows/vector-validation.yml` is a **separate** workflow from CI:

- Triggers: `workflow_dispatch` (manual) and a weekly `schedule`. **Never** on
  push/PR, so it can't block normal CI.
- Steps: checkout → setup Node + gcloud → write SA creds → install → build →
  `firebase deploy --only firestore:indexes` → poll until indexes are `READY`
  (up to 30 min) → run the real test with `GHOST_VECTOR_REAL=1`.
- If any required secret is missing (e.g. on a fork), the guard step marks the
  run as skipped and all real steps are no-ops, so the job still succeeds.

## Cost & cleanup notes

- **Cost**: this uses a real, billable Firestore database. Each run performs a
  handful of small writes/reads/deletes (3 fixture docs), so per-run cost is
  negligible. The non-trivial cost is keeping a vector index provisioned on the
  test project.
- **Index build time**: deploying/building a vector index can take **several
  minutes** (occasionally longer on first creation); the workflow waits up to 30
  minutes for `READY`. Locally, ensure the index is READY before running.
- **No embedding spend**: the embedding provider is mocked, so the test makes no
  paid embedding API calls.
- **Cleanup**: the test deletes its seeded docs in `afterAll`, and all fixtures
  live under the guarded `ghost_vec_real_*` userId namespace. If a run is
  interrupted, remove leftovers with
  `npx tsx scripts/seed-vector-fixtures.ts cleanup <userId>`.
- **Data safety**: seeding/cleanup refuse any userId outside the
  `ghost_vec_real_` prefix, so real user data can never be affected.
