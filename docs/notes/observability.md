# Observability (OpenTelemetry → Google Cloud)

Tracing + latency/throughput metrics for GHOST Agent Builder, built on
OpenTelemetry and exported toward **Google Cloud Trace** (spans) and **Google
Cloud Monitoring** (metrics).

All wiring lives in `functions/src/telemetry.ts` and is consumed via small,
crash-proof helpers. Instrumentation never changes request behaviour: every
helper is wrapped so a telemetry failure can never break a request, and all
helpers degrade to no-ops when no exporter/provider is active.

## Components

| Piece | Where | Purpose |
| --- | --- | --- |
| OTel SDK init | `telemetry.ts` `initTelemetry()` | Starts `NodeSDK` with the Cloud Trace exporter + a Cloud Monitoring metric reader. Lazy `require`, guarded, idempotent. |
| `startSpan(name, fn, attrs?)` | `telemetry.ts` | Runs `fn` in an active span, records `<name>.duration_ms`, sets status, re-throws errors. Sync or async. |
| `recordLatency(metric, ms, attrs?)` | `telemetry.ts` | Records a millisecond latency into a histogram. |
| `recordCounter(name, attrs?, value=1)` | `telemetry.ts` | Increments a counter. |
| `recordError(err, attrs?)` | `telemetry.ts` | The error sink: records the exception on the active span, increments `errors_total`, and emits a structured `telemetry_error` log. |
| `timed(metric, fn, attrs?)` | `log.ts` | Lightweight latency timer without a full span. |
| request metrics | `log.ts` `requestId` middleware | Per-request latency/throughput, emitted on `res 'finish'`. |
| vector metrics | `memory.ts` `searchMemory` | Retrieval span + latency/throughput/result-count, tagged by backend. |

## What's traced

- **`vector.search`** span around every `searchMemory()` call. Attributes:
  `vector.backend` (`firestore` | `in-memory`), `vector.limit`,
  `vector.result_count`. This is the headline signal for retrieval health in
  Cloud Trace.
- Any unit of work wrapped in `startSpan(...)`. Each span also emits a
  `<name>.duration_ms` latency histogram so durations are queryable as metrics,
  not just visible as trace waterfalls.
- **HTTP requests**: latency/throughput metrics are emitted per request from the
  `requestId` middleware (imported app-wide via `index.ts`, so no router edits
  are needed). Full distributed HTTP/Express *span* auto-instrumentation
  additionally requires starting the SDK before `express`/`http` are required —
  see Follow-ups.

## Metric names

| Metric | Type | Attributes | Meaning |
| --- | --- | --- | --- |
| `http_server_request_ms` | histogram (ms) | `method`, `status`, `route` | Per-request server latency. |
| `http_server_requests_total` | counter | `method`, `status`, `route` | Request throughput. |
| `vector_search_ms` | histogram (ms) | `backend`, `error?` | Retrieval latency per `searchMemory`. |
| `vector_search_total` | counter | `backend` | Number of retrieval calls. |
| `vector_search_results_total` | counter | `backend` | Sum of chunks returned (→ avg results/call). |
| `vector_search_candidates_total` | counter | `backend` | Candidates scanned by the in-memory backend. |
| `vector_candidate_cap_hit_total` | counter | — | Times the in-memory candidate cap was hit (recall risk). |
| `vector_search_fallback_total` | counter | `reason` | Firestore `findNearest` → in-memory fallbacks (degraded retrieval). |
| `vector.search.duration_ms` | histogram (ms) | `vector.backend` | Span-level retrieval duration (from `startSpan`). |
| `errors_total` | counter | `error.type`, + caller attrs | Errors routed through `recordError`. |

`route` deliberately uses the matched Express route path (or base path), never
the raw URL, to keep metric cardinality bounded.

## Environment / configuration

Export only happens in a real cloud runtime. `telemetryEnabled()` returns
`false` (hard no-op, SDK never starts, no gRPC/metadata calls) when **any** of:

- `OTEL_DISABLED=1` (explicit kill switch), or
- `NODE_ENV === "test"` or `VITEST` is set (unit tests), or
- `FUNCTIONS_EMULATOR` is set (Functions emulator), or
- `FIRESTORE_EMULATOR_HOST` is set (Firestore emulator), or
- no GCP project is configured.

Project resolution (first non-empty wins):
`GOOGLE_CLOUD_PROJECT` → `GCLOUD_PROJECT` → `GCP_PROJECT`. In deployed Cloud
Functions these are set by the runtime, so no extra config is required. The
function's service account needs `roles/cloudtrace.agent` and
`roles/monitoring.metricWriter`.

Metrics are flushed to Cloud Monitoring every 60s (its minimum write interval
per time series).

## Local / test behaviour

- Unit tests (`npm test`): SDK never starts. Helpers use the global no-op meter
  unless a test installs its own `MeterProvider` (see `test/telemetry.test.ts`,
  which drives the helpers against an in-memory exporter). No network, no GCP.
- Emulator (`npm run serve`): same no-op behaviour.
- Cold-start cost: at module load only `@opentelemetry/api` (a tiny shim) is
  imported. The heavy SDK + GCP exporters are `require`d lazily inside
  `initTelemetry()` and only in a real runtime.

## Adopting `recordError` in routes (follow-up)

`recordError` is the durable error sink the codebase previously left as a TODO.
Routes/services can adopt it in catch blocks without any telemetry boilerplate:

```ts
import { recordError } from "../telemetry";

try {
  // ...handler work...
} catch (err) {
  recordError(err, { route: "ingest", userId });
  return sendError(res, 500, "internal");
}
```

When called inside a `startSpan`, the exception is attached to the active span
(visible in Cloud Trace) and counted in `errors_total`; outside a span it still
counts + logs, so it is always safe.

## Dashboards / alerting this enables (feeds Agent J)

- **Retrieval health**: p50/p95 `vector_search_ms` by backend; fallback rate via
  `rate(vector_search_fallback_total)`; recall risk via
  `vector_candidate_cap_hit_total`; avg results via
  `vector_search_results_total / vector_search_total`.
- **API health**: p95 `http_server_request_ms`, error-rate from
  `http_server_requests_total{status=~"5.."}`.
- **Error budget**: `rate(errors_total)` split by `error.type`/`route`.
- **Traces**: `vector.search` spans for slow-request drill-down in Cloud Trace.

## Follow-ups (cross-file, out of this change's ownership)

1. **`index.ts` bootstrap**: call `initTelemetry()` at the very top of
   `index.ts` (before importing `express`/`http`/routers) to enable full
   HTTP/Express auto-instrumentation and guarantee SDK start before first
   request. The manual spans/metrics here do not depend on it; this only adds
   automatic incoming-request spans.
2. **Routes adopt `recordError`** in their catch blocks (see above).
3. Optional: tune `exportIntervalMillis` / add OTel resource detectors if richer
   GCP resource labels are wanted.
