# ADR-0001 — Vector search: Firestore Vector Search vs external vector DB

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** `functions/src/memory.ts`, `functions/src/github.ts`, `functions/src/routes/{ask,design,plans}.ts`, `firestore.indexes.json`

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
  is `READY`, switch `searchMemory` to `findNearest`. No data reshape required if
  the stored dimension matches the index.

## Impact on files

- `functions/src/memory.ts` — replace the `limit(1500)` + in-memory sort with a
  `findNearest(...)` vector query (Backend).
- `firestore.indexes.json` — Architect adds the vector index/`fieldOverride` for
  `knowledge_chunks.embedding` (dimension + distance measure `COSINE`) once the
  embedding dimension is confirmed. **Open question:** confirm embedding dimension
  from the active provider before pinning the index.
- Callers (`ask.ts`, `design.ts`, `plans.ts`, `github.ts`) are unaffected — the
  `searchMemory(query, scope, limit)` signature stays stable.
