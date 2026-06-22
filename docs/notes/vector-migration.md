# Vector backend migration — Firestore Vector Search as default

Status: implemented on `feature/vector-backend`. Companion to
[ADR-0001](../adr/ADR-0001-vector-search.md).

## What changed

- **Firestore Vector Search (`findNearest`) is now the DEFAULT vector backend.**
  Previously the in-memory cosine index was the default and `findNearest` was
  opt-in via `VECTOR_BACKEND=firestore`.
- Backend selection (`functions/src/pure.ts` `selectVectorBackend`) now resolves:
  1. `VECTOR_BACKEND=memory`    → in-memory cosine (explicit opt-out)
  2. `VECTOR_BACKEND=firestore` → Firestore Vector Search (explicit opt-in)
  3. running under the emulator → in-memory cosine (auto fallback; the Firestore
     emulator has no `findNearest`)
  4. anything else, incl. unset → Firestore Vector Search (**new default**)
- **Graceful runtime fallback:** if a `findNearest` query throws (index not
  `READY`, unsupported, transient error) `FirestoreVectorIndex.search` logs a
  structured `vector_findnearest_fallback_inmemory` warning and serves that
  single request from the in-memory cosine path, reusing the already-computed
  query embedding. Retrieval never hard-fails.
- **Real similarity scores:** the Firestore backend now requests
  `distanceResultField: "vector_distance"` and returns `score = 1 - distance`
  (COSINE distance ∈ [0, 2]), preserving the "higher = closer" ordering used by
  the in-memory path. If the SDK does not surface a distance it falls back to a
  neutral `0` and relies on retrieval order.

Caller signatures (`searchMemory`, `gatherContext`) are unchanged.

## Emulator behaviour

The Firestore emulator does not implement `findNearest`, so:

- selection auto-detects the emulator via `FUNCTIONS_EMULATOR` or
  `FIRESTORE_EMULATOR_HOST` and uses the in-memory backend, and
- the integration suite `functions/test/integration/vector_backend.test.ts`
  self-skips its emulator-gated cases when no emulator is present (matching the
  repo convention), while the pure selection-policy cases always run.

## Building the vector index (production)

1. Confirm the embedding dimension of the **active** provider (see caveat below)
   and ensure `firestore.indexes.json` matches it. The repo already declares:
   - a single-field `fieldOverrides[].vectorConfig` on
     `knowledge_chunks.embedding`, and
   - composite vector indexes for the scoped queries actually issued —
     `userId + embedding`, `userId + topicId + embedding`,
     `userId + projectId + embedding`.
   (COSINE is selected at query time; the flat KNN index supports all distance
   measures, so it is intentionally not part of the index JSON.)
2. Deploy the indexes:
   ```bash
   firebase deploy --only firestore:indexes
   ```
3. Wait for every vector index to reach state `READY` (the Firestore console
   shows build progress). Until then, `findNearest` errors are caught and served
   by the in-memory fallback, so retrieval keeps working (with bounded recall).
4. Ensure embeddings are stored as **Firestore vector values**
   (`FieldValue.vector([...])`), not plain arrays. Plain-array embeddings are
   ignored by the vector index even though the in-memory path can still read
   them — back-populate existing `knowledge_chunks` if needed.

## Dimension caveat (open question)

The vector index pins a fixed `dimension`. It is provider-dependent:

| Provider              | Embedding model (typical) | Dimension |
|-----------------------|---------------------------|-----------|
| OpenAI                | `text-embedding-3-small`  | 1536      |
| Azure OpenAI          | `text-embedding-3-small`  | 1536      |
| Gemini                | `text-embedding-004`      | 768       |

`firestore.indexes.json` currently pins **1536** (OpenAI/Azure default). A
Firestore vector index cannot be configured per-document, and the JSON cannot be
env-templated at deploy time, so the dimension is effectively a frozen contract
value per project. Rather than hard-failing, the design tolerates a mismatch:
documents whose embedding dimension differs from the index simply aren't matched
by `findNearest`, and the runtime fallback still serves them from the in-memory
path. **Open question (carried from ADR-0001):** standardise on a single
embedding dimension/provider per deployment, or maintain provider-specific
index variants. Until resolved, keep the pinned dimension aligned with the
provider whose embeddings dominate `knowledge_chunks`.

## Rollback

Fully reversible without code changes:

- **Per environment:** set `VECTOR_BACKEND=memory` to force the in-memory cosine
  index everywhere (the previous default behaviour). No redeploy of indexes
  required.
- **Per request:** already automatic — `findNearest` failures fall back to
  in-memory for that request.
- **Code rollback:** revert the `feature/vector-backend` changes; the in-memory
  path is unchanged underneath.

The vector indexes can be left in place when rolling back (they are inert unless
`findNearest` is issued) or removed via `firebase deploy --only firestore:indexes`
after deleting them from `firestore.indexes.json`.

## Micro-benchmark — in-memory candidate scan vs top-k findNearest

The in-memory backend loads up to `VECTOR_CANDIDATE_CAP` (default 1500)
candidate docs and scores them in-process: **O(N·d)** cosine plus an O(N log N)
sort. Measured on this machine (Node `v25.9.0`, f64 arrays, scan + top-8 sort
only — i.e. **CPU only, excluding the Firestore reads/egress**):

| Candidates (N) | Dim (d) | Multiply-adds | In-process scan + sort | Embedding bytes held |
|----------------|---------|---------------|------------------------|----------------------|
| 1500           | 1536    | 2.30 M        | ~4.0 ms                | ~18 MB               |
| 1500           | 768     | 1.15 M        | ~1.7 ms                | ~9 MB                |
| 5000           | 1536    | 7.68 M        | ~9.5 ms                | ~61 MB               |
| 10000          | 1536    | 15.36 M       | ~19.2 ms               | ~123 MB              |

Reproduce with the snippet in this PR's notes (ephemeral `node -e` scan over
random vectors). The CPU cost is modest, but it grows linearly with corpus size
and the cap silently bounds recall once N exceeds it.

**The dominant real-world cost is NOT the CPU scan — it is the Firestore reads.**
The in-memory path reads up to N documents per query, each carrying a full
embedding array (~`d`×4–8 bytes), on **every** Q&A / design / plan request:

- in-memory: up to **N document reads** + egress per request (N≤1500 today),
  recall capped at N;
- `findNearest`: **k document reads** (k = `limit`, typically 8) per request,
  recall unbounded by the cap, scoring done server-side.

So for a user with 1500 chunks and `limit=8`, `findNearest` cuts per-query reads
by ~**185×** (1500 → 8) and removes the per-request embedding egress and the
in-instance O(N·d) scan / memory spike, which is the original ADR motivation.
A full end-to-end latency comparison against a live `findNearest` index could not
be measured here (no Firestore emulator/Java available locally; the emulator does
not support `findNearest` regardless).
