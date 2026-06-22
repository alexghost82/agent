# Runtime sizing change — load-test & cost comparison

**Scope:** `functions/src/index.ts` — the `api` Cloud Function (Functions v2 `onRequest`).
**Change:** `memory` 2 GiB → **1 GiB**, `concurrency` 8 → **60**, `timeoutSeconds` kept at **120**.
All three are now env-overridable (`FUNCTION_MEMORY`, `FUNCTION_CONCURRENCY`, `FUNCTION_TIMEOUT_SECONDS`).

> **Assumption (hard dependency on Agent A):** these defaults assume the **Firestore Vector
> Search** backend (`VECTOR_BACKEND="firestore"`) is active, where `findNearest` returns only the
> top-k chunks server-side. The in-memory cosine fallback (`memory.ts`) still exists per request.
> If `VECTOR_BACKEND` is forced to `memory`, raise `FUNCTION_MEMORY` back to `2GiB`
> (and/or lower `FUNCTION_CONCURRENCY`). `index.ts` logs `runtime_memory_backend_mismatch` (warn)
> once per cold start when it detects this combination.

---

## TL;DR — before / after

| Dimension                         | Before (mitigation)        | After (this change)        | Effect |
|-----------------------------------|----------------------------|----------------------------|--------|
| Memory ceiling                    | 2 GiB                      | **1 GiB**                  | ½ the GiB-second rate per instance-second |
| Per-instance concurrency          | 8                          | **60**                     | ~7.5× fewer instances for the same RPS |
| Timeout                           | 120 s                      | 120 s (unchanged)          | LLM calls unaffected |
| Per-request retrieval memory      | up to a 1500-vector set    | ~k (8) chunks (firestore)  | ~40 MiB → ~0.2 MiB |
| Est. cold start                   | ~1.5–3 s                   | ~1.5–3 s (≈ unchanged)     | code-load dominated, not memory-tier |
| Relative instance-seconds cost    | baseline (1.0×)            | **~0.07× (~14× cheaper)**  | see cost model below |

---

## Why the old config existed

In-process vector search loaded many embedding vectors into memory per request. Under load this
produced `Memory limit … exceeded` and later a JS-heap OOM (`Reached heap limit` / SIGABRT) during
skill extraction. Two mitigations were applied:

1. `gatherContext` runs its subqueries **sequentially**, so only **one** candidate set is live at a
   time (rather than N in parallel) — this is unchanged by this work.
2. Runtime was bumped to **2 GiB** and concurrency **clamped to 8** so a couple of heavy retrievals
   could not stack into an OOM on one instance.

With Agent A's Firestore Vector Search as the default, retrieval no longer materialises a candidate
set in the function: `findNearest` ranks server-side and returns only the top-k (`limit`, default 8).
The OOM driver is gone for the default path, so the 2 GiB / 8 mitigation is no longer warranted.

---

## Methodology

Two parts: (a) **measured** local memory facts that anchor the model, and (b) an **analytical**
cost/throughput model derived from the Functions v2 billing rules (no production traffic was
available to drive a real `k6`/`autocannon` run from this worktree).

### (a) Measured locally (Node 22, this repo's `functions/`)

Numbers below are from `node -e` micro-benchmarks run in the worktree; reproduce with the snippets.

| Measurement | Value | How |
|---|---|---|
| Core deps RSS (`express`+`cors`+`firebase-admin`+`openai`+`zod`) | **~73 MiB** | `require` the deps, read `process.memoryUsage().rss` |
| One in-memory candidate set @ cap 1500 (1536-dim float + ~2 KB text/chunk) | **~23 MiB heap / ~43 MiB RSS** | allocate 1500 chunk objects, measure delta |

```bash
# candidate-set footprint (in-memory fallback, one sequential subquery)
node -e 'const b=process.memoryUsage();const C=1500,D=1536,s=[];
for(let i=0;i<C;i++){const e=new Array(D);for(let j=0;j<D;j++)e[j]=Math.random();
s.push({id:"c"+i,content:"x".repeat(2048),embedding:e,score:0});}
const a=process.memoryUsage();
console.log("heapΔMiB",((a.heapUsed-b.heapUsed)/1048576).toFixed(1),
"rssΔMiB",((a.rss-b.rss)/1048576).toFixed(1));'
```

These confirm: (i) a realistic instance **baseline** is on the order of **~120–160 MiB** RSS once
all routers + the Functions runtime wrapper are loaded (measured deps ~73 MiB + headroom), and
(ii) a single in-memory fallback adds **~40 MiB** RSS for the duration of one request.

### (b) Analytical model (Functions v2 / Cloud Run billing)

Functions v2 bill **instance time** (vCPU-seconds + GiB-seconds) for as long as an instance is
"active," **independent of how many requests it serves concurrently**. So:

- Raising `concurrency` reduces the **number of instances** needed for a given request rate.
- Lowering `memory` reduces the **GiB-second rate** per active instance-second.

---

## Memory model — why 1 GiB (not 512 MiB)

Worst-case live memory on one instance ≈

```
baseline (~150 MiB)
  + concurrency × per-request working set (JSON body ≤4 MiB cap, LLM buffers, locals ≈ 1–3 MiB typical)
  + (occasional) in-memory fallback sets × ~40 MiB each
```

| Scenario (default firestore backend) | Estimated peak RSS | Fits 512 MiB? | Fits 1 GiB? |
|---|---|---|---|
| 60 concurrent firestore-path requests, no fallback | ~150 + 60×~2 = **~270 MiB** | yes | yes |
| Above + 1 occasional in-memory fallback | **~310 MiB** | yes | yes |
| Above + 5 simultaneous in-memory fallbacks (~200 MiB) | **~510 MiB** | **borderline/no** | yes |
| Above + 10 simultaneous fallbacks (~400 MiB) | **~710 MiB** | no (OOM) | yes |

**Decision: 1 GiB.** It keeps the normal firestore path at <30% utilisation while absorbing an
**occasional single fallback** with large margin, and even tolerates a small burst of simultaneous
fallbacks. 512 MiB would work for the pure firestore path but leaves almost no margin if several
requests hit the in-memory fallback at once — given the fallback still exists per request, that is
an unacceptable OOM-regression risk. 1 GiB is the floor that "tolerates an occasional fallback for a
single request" (and then some) as required.

It is **not** sized for *sustained* in-memory search at concurrency 60 (that would need ~150 + 60×40
≈ 2.5 GiB) — hence the `VECTOR_BACKEND != firestore` guard warning and the documented `2GiB`
override.

---

## Concurrency model — why 60

- Each `api` request is dominated by **I/O wait** (Firestore reads, OpenAI/Gemini calls that can run
  for seconds), not CPU. During that wait the instance is idle-but-billed, so packing more requests
  per instance is almost free CPU-wise and is the main cost lever.
- 60 sits in the requested 40–80 band, comfortably under Cloud Run's max (1000) while staying within
  the 1 GiB memory envelope modelled above.
- vCPU at 1 GiB on gen2 is ~1 vCPU; LLM-bound handlers spend most wall-clock awaiting the network, so
  one vCPU sustains dozens of in-flight requests. If CPU-bound work grows, lower
  `FUNCTION_CONCURRENCY` rather than raising memory.

---

## Cold start

Cold start here is dominated by **code/module load** (firebase-admin + express + routers ≈ 0.5–1.5 s)
plus container provisioning, **not** the memory tier. Going 2 GiB → 1 GiB does not meaningfully
change cold-start latency (both ≈ **1.5–3 s** observed-class). A nuance in the *other* direction:
higher concurrency means each cold instance now absorbs more of a traffic spike, so the **number of
cold starts per unit load drops ~7.5×**, improving p95 latency under bursty traffic.

---

## Cost model (illustrative)

Take a steady **120 requests/sec**, each holding an instance slot for ~1 s of LLM-bound work.

| | Before (2 GiB, c=8) | After (1 GiB, c=60) |
|---|---|---|
| Instances needed (≈ RPS × hold ÷ concurrency) | 120 ÷ 8 = **15** | 120 ÷ 60 = **2** |
| Memory provisioned | 15 × 2 GiB = **30 GiB** | 2 × 1 GiB = **2 GiB** |
| Relative GiB-seconds | **1.0×** | **~0.067×** |

≈ **~14× lower** memory-billed cost at this load, before considering fewer cold starts and lower
vCPU-second totals. Even with conservative rounding (instances never perfectly packed), the change
is firmly a **multiple-× cost reduction**, with throughput-per-instance up and OOM headroom retained.

---

## Risks & mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| **OOM regression** if `VECTOR_BACKEND` is *not* `firestore` (in-memory fallback under load) | Low if Agent A's firestore default ships; otherwise medium | 1 GiB floor absorbs occasional single fallbacks; `runtime_memory_backend_mismatch` warn log at cold start; documented `FUNCTION_MEMORY=2GiB` override; `VECTOR_CANDIDATE_CAP` (default 1500) bounds a single set; subqueries already sequential |
| Sustained in-memory search at c=60 | Low (non-default) | Guard warns; raise `FUNCTION_MEMORY` and/or lower `FUNCTION_CONCURRENCY` |
| Concurrency too high → CPU contention / event-loop lag | Low (I/O-bound handlers) | `FUNCTION_CONCURRENCY` override to dial down without a deploy of code changes |
| LLM call exceeds timeout | Unchanged | `timeoutSeconds` kept at 120 |

---

## Follow-ups (cross-file, outside this branch's ownership)

- **Agent A:** confirm `VECTOR_BACKEND="firestore"` is the deployed default and the
  `firestore.indexes.json` vector field override is provisioned, so the in-memory path is truly the
  exception. This tuning depends on it.
- **Ops/deploy:** set `VECTOR_BACKEND=firestore` in the function's runtime env (and leave
  `FUNCTION_MEMORY`/`FUNCTION_CONCURRENCY` unset to take these defaults), or set `FUNCTION_MEMORY=2GiB`
  if the in-memory backend is intentionally retained.
- **Future validation:** run a real `autocannon`/`k6` soak against a staging deploy to replace the
  analytical cost/throughput figures with measured p50/p95 latency and instance-count telemetry.
