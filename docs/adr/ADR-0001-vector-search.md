# ADR-0001 — Vector search: Firestore Vector Search vs external vector DB

- **Status:** Accepted — **Implemented (Firestore Vector Search is now the default backend, with emulator + runtime fallback to in-memory cosine).** See [vector-migration notes](../notes/vector-migration.md).
- **Owner:** Architect
- **Affects:** `functions/src/memory.ts`, `functions/src/pure.ts`, `functions/src/github.ts`, `functions/src/routes/{ask,design,plans}.ts`, `firestore.indexes.json`

> **Status update (feature/vector-backend):** the decision below is implemented.
> `findNearest` (Firestore Vector Search) is the **default** backend in real
> runtimes; `selectVectorBackend` resolves explicit `VECTOR_BACKEND=memory` /
> `=firestore`, auto-falls back to the in-memory cosine index under the Firestore
> emulator (no `findNearest` support), and otherwise defaults to firestore. A
> `findNearest` failure (index not `READY` / unsupported) is caught and served
> from the in-memory path for that request, so retrieval never hard-fails. The
> Firestore backend now surfaces a real COSINE similarity score
> (`1 - distance`). The embedding **dimension is still an open question** — it is
> provider-dependent (OpenAI/Azure 1536, Gemini 768) and pinned in
> `firestore.indexes.json` (currently 1536); see the migration notes.

## Context

`memory.ts:24-45` (`searchMemory`) loads up to **1500** `knowledge_chunks` for the
user (optionally narrowed by `topicId`/`projectId`) and computes cosine similarity
**in process** (`pure.ts` `cosineSimilarity`). This is the primary scaling
bottleneck:

- Cost: every Q&A / design / plan reads up to 1500 docs (each carrying a full
  embedding array) → unbounded Firestore read cost and egress.
- Recall: silently capped at 1500 candidates; large memories lose accuracy.
- Latency/memory: O(N·d) per request inside the function instance.

## Decision

Adopt **Firestore Vector Search** (the native `KNN` vector index + `findNearest`
query) as the target backend for similarity search. Embeddings continue to live on
the `knowledge_chunks` documents; queries move from "load 1500 + cosine in memory"
to a server-side nearest-neighbor query scoped by `userId` (+ optional
`topicId`/`projectId`).

We explicitly **reject** introducing an external vector DB (Pinecone / Weaviate /
pgvector) for now:

- It adds a second datastore, second set of credentials, dual-write consistency,
  and another tenant-isolation surface — disproportionate for the current scale.
- Firestore Vector Search keeps data, isolation, and billing in one system and
  preserves the "all access via Admin SDK, deny-all client rules" model.

Re-evaluate if memory size or QPS outgrows Firestore Vector Search limits.

## Consequences

- **Positive:** bounded reads (top-k instead of 1500), better recall, lower
  function memory, no new datastore.
- **Negative:** requires a **vector index** in `firestore.indexes.json`
  (`fieldOverrides` / vector config) with a fixed embedding dimension; embedding
  dimension becomes a frozen contract value; back-population of existing chunks
  needed.
- **Migration:** existing chunks already store `embedding`; once the vector index
  is `READY`, `searchMemory` uses `findNearest` by default. No data reshape
  required if the stored dimension matches the index **and** embeddings are
  stored as Firestore vector values (plain arrays are ignored by the index — see
  the migration notes). Until the index is `READY`, the runtime fallback keeps
  retrieval working from the in-memory path.

## Impact on files

- `functions/src/memory.ts` — **done.** `FirestoreVectorIndex` issues
  `findNearest(... distanceMeasure: "COSINE", distanceResultField: "vector_distance")`
  and is the default backend; `InMemoryCosineIndex` remains as the emulator and
  runtime fallback. (Backend)
- `functions/src/pure.ts` — **done.** `selectVectorBackend` implements the
  firestore-default-with-emulator-fallback policy (kept pure/unit-testable).
- `firestore.indexes.json` — vector `fieldOverride` + composite vector indexes
  for `knowledge_chunks.embedding` are declared. **Open question (still open):**
  confirm/standardise the embedding dimension from the active provider; it is
  pinned at 1536 today and cannot be templated per provider.
- Callers (`ask.ts`, `design.ts`, `plans.ts`, `github.ts`) are unaffected — the
  `searchMemory(query, scope, limit)` signature stays stable.
