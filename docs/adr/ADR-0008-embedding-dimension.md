# ADR-0008 — Embedding dimension: one canonical dimension via a normalization layer

- **Status:** Accepted — **Implemented** (normalization layer in `functions/src/ai.ts`).
- **Owner:** Architect
- **Affects:** `functions/src/ai.ts`, `functions/src/learn.ts`, `firestore.indexes.json`
- **Relates to:** [ADR-0001 — Vector search](./ADR-0001-vector-search.md) (resolves its "open question" on embedding dimension) and the [vector-migration notes](../notes/vector-migration.md).

## Context

ADR-0001 made Firestore Vector Search the default similarity backend. A Firestore
vector index (`fieldOverrides` / `vectorConfig`) requires a **single, fixed
dimension** for the indexed field — it cannot be templated per provider. But the
embedding providers we support emit **different** dimensions:

| Provider | Model | Native dimension |
| --- | --- | --- |
| OpenAI | `text-embedding-3-small` | 1536 |
| Azure OpenAI | (deployment-dependent) | configurable (often 1536/3072) |
| Gemini | `text-embedding-004` | 768 |

`embedding(text, userId)` / `embeddingBatch(...)` in `ai.ts` resolve a provider per
user (and fall back across embedding-capable providers when the active provider —
e.g. Anthropic — cannot embed). So a single user, and certainly a single index, can
see a **mix** of 768- and 1536-dim vectors. `firestore.indexes.json` currently pins
`knowledge_chunks.embedding` at **1536**. A 768-dim vector written to that index is
incompatible: `findNearest` cannot match across dimensions, and a dimension mismatch
either errors or silently drops the document from the index. This is the conflict
this ADR resolves.

## Options considered

### (a) Multi-dimension collections / per-provider indexes
Store each provider's vectors in their own collection (or field) with its own vector
index at the native dimension (e.g. `knowledge_chunks_1536`, `knowledge_chunks_768`),
and fan-out queries to the index that matches the query embedding's provider.

- **Pros:** no information loss; each vector stays at its native dimension.
- **Cons:**
  - **Cross-provider retrieval breaks.** A user who switches OpenAI→Gemini (or whose
    Anthropic key forces an embedding fallback) can no longer retrieve memories
    embedded under the other provider — cosine across different model spaces is not
    meaningful anyway, but the hard split makes prior memory invisible.
  - Multiplies indexes, composite-index permutations (`userId`,
    `userId+topicId`, `userId+projectId`) and `fieldOverrides` per dimension.
  - Query path must branch on provider and possibly query+merge multiple indexes.
  - Operationally heavier (more indexes to build/keep `READY`, more cost).

### (b) Dimension-normalization layer — **CHOSEN**
Normalize **every** embedding to a single canonical dimension `TARGET_EMBED_DIM`
(default **1536**) immediately after the provider call, before it is ever stored or
used as a query vector. The index has exactly one dimension; all vectors are
index-compatible regardless of provider.

- **Pros:** one index, one dimension, no query-path branching; provider switches and
  embedding-fallback keep working; smallest blast radius (logic lives in the single
  `ai.ts` funnel that both ingestion and query already go through).
- **Cons:** normalization is **lossy** for providers whose native dimension differs
  from the target (see trade-offs). Acceptable because retrieval here is approximate
  ranking, not exact reconstruction, and quality across heterogeneous provider spaces
  is already approximate.

## Decision

Adopt **option (b): a normalization layer.** Introduce a pure function
`normalizeEmbedding(vec, targetDim = TARGET_EMBED_DIM)` in `ai.ts` and apply it
inside the `embedding()` and `embeddingBatch()` funnel so **both** the ingestion path
(`learn.ts` → `embeddingBatch`/`embedding`) and the query path (`memory.ts` →
`embedding`) automatically receive canonical-dimension vectors. No normalization
logic is duplicated in `learn.ts` (it only stores what the funnel returns).

`TARGET_EMBED_DIM` is environment-configurable (`TARGET_EMBED_DIM`, default `1536`)
and **must equal** the `dimension` declared for `knowledge_chunks.embedding` in
`firestore.indexes.json`. Changing one without the other breaks the index contract.

### Normalization algorithm

`normalizeEmbedding(vec, targetDim)`:

1. **Dimension map**
   - `len === targetDim` → unchanged (copy).
   - `len > targetDim` → **average-pool** (deterministic block mean): output bucket
     `i` is the mean of the contiguous input range `[floor(i·len/target),
     floor((i+1)·len/target))`. We pick average-pooling over plain **truncation**
     because it keeps a contribution from *every* input coordinate instead of
     discarding the tail; it is deterministic and dependency-free. (We deliberately
     avoid a learned random projection — it would need a persisted, versioned matrix
     and reproducibility guarantees across instances, which is overkill here.)
   - `len < targetDim` → **zero-pad** the remaining coordinates.
2. **L2-renormalize** to unit length so cosine similarity stays meaningful and
   comparable across providers. A genuinely zero vector (norm 0) is returned as-is to
   avoid `NaN`.

### Trade-offs of the mapping

- **Truncation:** cheapest, but throws away the tail coordinates entirely. Rejected
  in favor of average-pooling.
- **Zero-pad (up-projection):** exact for the first `len` coordinates; the padded
  tail carries no signal, so a 768-dim Gemini vector lives in a 768-dim subspace of
  the 1536-dim index. Cosine between two padded Gemini vectors is preserved exactly
  (the zeros never contribute); cosine between a Gemini (padded) and an OpenAI
  (native 1536) vector is not meaningful — but cross-provider cosine was never
  meaningful regardless of dimension.
- **Average-pool (down-projection):** lossy but uses all input signal; preserves
  coarse direction, not exact angles.
- **L2-renormalization** is cosine-preserving (scale-invariant): for an
  already-unit-norm provider output (OpenAI returns normalized vectors) it is a
  **no-op**, so same-dimension providers are effectively unchanged.

## Consequences

- **Positive:** single fixed-dimension index; provider switching and Anthropic
  embedding-fallback never produce index-incompatible vectors; the change is
  localized to `ai.ts`; `embedding()`/`embeddingBatch()` signatures are unchanged.
- **Negative:** non-1536 providers are stored in a normalized (lossy) form; their
  retrieval quality depends on the mapping, not their native space.
- **Neutral:** because cosine is scale-invariant and OpenAI vectors are already unit
  norm, existing OpenAI-only deployments see no behavioral change.

## Why not multi-collection (summary)

Multi-collection optimizes for native fidelity per provider but pays for it with
N× indexes, provider-branching query code, and the loss of a single unified memory
across provider switches — the opposite of what a per-user, provider-swappable agent
memory needs. The normalization layer keeps one coherent memory at a modest, bounded
quality cost.

## Migration / rollback

- **Forward migration (follow-up, not in this change):** chunks embedded **before**
  this change with a non-`TARGET_EMBED_DIM` dimension (e.g. 768-dim Gemini chunks)
  are still stored at their native size and will be ignored / incompatible with the
  fixed-dimension vector index. They must be **back-populated**: re-run
  `normalizeEmbedding` over stored embeddings (cheap, no re-embedding needed when the
  raw vector is still present) or re-embed + renormalize, then rewrite the
  `embedding` field as a Firestore vector value. Until then, the ADR-0001 runtime
  fallback (in-memory cosine) keeps retrieval working for those rows.
- **Rollback:** the function is purely additive and behind the `ai.ts` funnel.
  Setting `TARGET_EMBED_DIM` back / removing the call reverts behavior; no schema
  reshape is required to stop normalizing (already-normalized rows remain valid unit
  vectors). Reverting the index dimension must stay in lockstep with the env value.
