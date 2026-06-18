# PERFORMANCE_REPORT.md

Ranked by ROI (impact vs. effort). Evidence in `path:line`.

---

## P1 — In-memory vector search loads up to 1500 docs per query — High impact
- **Evidence:** `functions/src/memory.ts:24-45`
  ```ts
  const snap = await q.limit(1500).get();
  const scored = snap.docs.map(... cosineSimilarity(qEmbedding, emb) ...);
  ```
- **Cost:** Every `ask`/`design`/`plan` reads up to 1500 Firestore docs (each carrying a full embedding array) and scores them in-process. Firestore read billing + egress + memory + latency all scale linearly with corpus size; recall is silently capped at 1500.
- **Fix:** Move to a vector index (e.g. Firestore Vector Search / dedicated vector DB) or pre-filter. **Gain:** Order-of-magnitude fewer reads and lower, bounded latency on large memories. **Effort:** M–H. **ROI: highest.**

## P2 — GitHub ingestion runs fully synchronously in the request — High impact
- **Evidence:** `functions/src/github.ts:84-111` — sequential per-file `fetchRawFile` then `embedding()` batches, all awaited inside `connect-github` (`routes/projects.ts:87-117`).
- **Cost:** Up to 200 files × (1 fetch + N embedding calls) serialized → long wall-clock; risk of function timeout and partial ingest (`ingestStatus:"error"`). Files are processed one-by-one (`for (const blob of blobs)`), not in parallel.
- **Fix:** Offload to a background task/queue (Cloud Tasks / Pub/Sub) with progress; parallelize file fetches with a concurrency cap. **Gain:** Reliability + large repos supported. **Effort:** M–H.

## P3 — Embeddings computed one HTTP call per chunk — Medium impact
- **Evidence:** `sources.ts:56` and `github.ts:90` map each chunk to its own `embedding()` call (`Promise.all` over a batch, but one network request per chunk).
- **Fix:** Use providers' batch embedding APIs (OpenAI accepts arrays). **Gain:** Fewer round-trips, lower latency/cost. **Effort:** M.

## P4 — Dashboard issues 8 aggregation queries + 50-doc read per load — Medium impact
- **Evidence:** `functions/src/routes/dashboard.ts:19-33`; the client reloads the dashboard on overview and after many mutations (`app/page.tsx:282,313,324,...`).
- **Cost:** 8 `count()` aggregations + 50 log doc reads each time; `count()` is billed and the overview refetches frequently.
- **Fix:** Cache counts (maintain counters via increments) or debounce refreshes. **Effort:** M.

## P5 — `ensureSeedUsers()` runs on every login — Low/Medium
- **Evidence:** `routes/public.ts:17` calls it before each verification; it does a `get()` per seed user (`auth.ts:43-56`).
- **Fix:** Seed once (deploy hook/idempotent migration) instead of per request. **Effort:** L.

## P6 — `agent_logs` grows unbounded; sorted in memory — Low/Medium
- **Evidence:** Every mutation writes a log (`util.ts:14-20`); dashboard fetches 50 then sorts in memory (`dashboard.ts:28-32`) because there is no `orderBy` (no index). Listing queries similarly fetch up to 200 and sort client-side (`topics.ts:13-15`, `sources.ts:19-21`).
- **Fix:** Add `createdAt` indexes + `orderBy(...).limit(...)`, and a TTL policy on logs. **Effort:** M.

## P7 — Per-key provider client cache can grow unbounded — Low
- **Evidence:** `providers/openai.ts:5` / `providers/gemini.ts:5` cache clients keyed by raw API key with no eviction. Long-lived instances with many distinct keys leak memory slowly.
- **Fix:** LRU cap. **Effort:** L.

## P8 — Frontend is a single 1153-line client component — Low (UX/maintainability)
- **Evidence:** `app/page.tsx`. All state and views in one component; fine for current size but re-renders broadly. **Effort:** M to split.

---

## Quick wins
- P5 (seed once), P7 (LRU), input bounds (also security).
## Strategic
- P1 (vector DB) and P2 (async ingestion) unblock scale.

## Performance/scalability score: 55/100
Acceptable at small scale; P1 + P2 are hard ceilings as data grows.
