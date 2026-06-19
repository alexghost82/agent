# PERFORMANCE_REPORT.md

Ranked by ROI (impact vs. effort). Evidence in `path:line`.

---

## Open issues

### P1 — In-memory vector search loads up to `VECTOR_CANDIDATE_CAP` docs per query — High impact
- **Evidence:** `functions/src/memory.ts:32-65`
  ```ts
  const cap = candidateCap();            // default 1500
  const snap = await q.limit(cap).get(); // each doc carries a full embedding
  // ...cosineSimilarity(qEmbedding, emb) scored in-process
  ```
- **Cost:** Every `ask`/`design`/`plan` reads up to the cap (default 1500)
  Firestore docs and scores them in-process; reads, egress, memory, and latency
  scale with corpus size, and recall is capped at the limit (a
  `vector_candidate_cap_hit` warning is logged when reached).
- **Fix:** Move to a real vector index (Firestore Vector Search `findNearest` /
  dedicated vector DB) behind the existing `VectorIndex` interface — callers do
  not change (CONTRACT §v2.1, ADR-0001). **ROI: highest.**

### P2 — GitHub ingestion runs fully synchronously in the request — High impact
- **Evidence:** `routes/projects.ts:104-150` awaits `ingestRepo(...)` inside the
  `connect-github` handler; `github.ts` fetches files and embeds within the same
  request. The `api` function has `timeoutSeconds: 120` (`index.ts:104-107`).
- **Cost:** Large repos risk hitting the function timeout and leaving
  `ingestStatus:"error"` / partial state.
- **Fix:** Offload to a background task/queue (Cloud Tasks / Pub-Sub) with
  progress + retries; parallelize file fetches with a concurrency cap.

### P3 — In-memory listing fallback on large collections — Low/Medium
- **Evidence:** `listing.ts:25-41` uses `orderBy(...).limit(...)` (indexed) but
  falls back to fetch-then-sort-in-memory if the index is missing during
  rollout.
- **Fix:** Ensure all listing indexes are deployed so the fallback path is never
  taken (`firestore.indexes.json` already defines them).

---

## Resolved since the previous report (verified in code)

- **Batched embeddings** — one provider call per batch instead of one per chunk
  (`ai.ts:71-77 embeddingBatch`, `routes/sources.ts:60-86`).
- **Dashboard counters** — a maintained `user_stats` doc replaces 8 `count()`
  aggregations per load (`stats.ts`, `routes/dashboard.ts`).
- **Seed users once per instance** — no longer per login
  (`auth.ts ensureSeedUsersOnce`, `routes/public.ts:61`).
- **`agent_logs` TTL + indexes** — `expireAt` field plus `userId, createdAt`
  index; ordered listing instead of always sorting in memory (`util.ts`,
  `firestore.indexes.json`, `listing.ts`).
- **LRU-bounded provider client cache** — capped at
  `PROVIDER_CLIENT_CACHE_MAX` (default 50) (`lru.ts`, `providers/*`).
- **Frontend componentized** — the single ~1000-line page is split into
  `app/components/**` and `app/components/panels/**`, narrowing re-renders.

---

## Quick wins
- P3 (confirm indexes deployed). 
## Strategic
- P1 (vector index) and P2 (async ingestion) are the remaining scale ceilings.

## Performance/scalability score: 74/100
Solid at small/medium scale; P1 + P2 are the hard ceilings as data and repo size
grow.
