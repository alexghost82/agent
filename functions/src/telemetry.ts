// OpenTelemetry wiring for traces + latency/throughput metrics, exported toward
// Google Cloud Trace (spans) and Cloud Monitoring (metrics).
//
// Design goals:
//   - ZERO behavioural impact on callers: every helper is wrapped so a telemetry
//     failure can never break a request, and all helpers degrade to no-ops.
//   - Cheap cold start: only `@opentelemetry/api` (a tiny no-op-by-default shim)
//     is imported at module load. The heavy SDK + GCP exporters are `require`d
//     lazily inside `initTelemetry()` and ONLY in a real cloud runtime.
//   - Safe under tests/emulator: init is a guarded no-op (see `telemetryEnabled`).
//
// The API-level `trace`/`metrics` accessors return no-op implementations until a
// provider is registered (by `initTelemetry()` in prod, or by a test harness via
// `metrics.setGlobalMeterProvider(...)`), so the helpers below are always safe.

import {
  trace,
  metrics,
  SpanStatusCode,
  type Span,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter
} from "@opentelemetry/api";
import { log } from "./log";

// Logical service name attached to spans/metrics; shows up as the Cloud Trace
// service and the Cloud Monitoring resource label.
export const SERVICE_NAME = "ghost-agent-builder";

// Resolve the configured GCP project from the standard env vars the runtime and
// gcloud set. Used both to decide whether export is possible and to pin the
// exporter target explicitly.
function gcpProject(): string | undefined {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    undefined
  );
}

// Telemetry EXPORT is enabled only in a real cloud runtime. We never spin up the
// OTel SDK (which opens gRPC channels to Cloud Trace/Monitoring and hits the GCP
// metadata server) under unit tests or the local emulator, nor when no GCP
// project is configured. `OTEL_DISABLED=1` is an explicit kill switch.
export function telemetryEnabled(): boolean {
  if (process.env.OTEL_DISABLED === "1") return false;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  if (process.env.FUNCTIONS_EMULATOR) return false;
  if (process.env.FIRESTORE_EMULATOR_HOST) return false;
  return !!gcpProject();
}

let initAttempted = false;
let sdkStarted = false;
// Kept so callers (e.g. a future index.ts bootstrap) could shut down cleanly.
let activeSdk: { shutdown(): Promise<void> } | undefined;

// Initialize the OpenTelemetry NodeSDK once. Idempotent and a guaranteed no-op
// when `telemetryEnabled()` is false. Returns true iff the SDK actually started
// (i.e. spans/metrics will be exported to GCP).
export function initTelemetry(): boolean {
  if (initAttempted) return sdkStarted;
  initAttempted = true;
  if (!telemetryEnabled()) return false;

  try {
    // Lazy requires: keep the heavy SDK + GCP exporters out of cold start for
    // tests/emulator. Only loaded here, in a real runtime.
    const { NodeSDK } = require("@opentelemetry/sdk-node");
    const { TraceExporter } = require("@google-cloud/opentelemetry-cloud-trace-exporter");
    const { MetricExporter } = require("@google-cloud/opentelemetry-cloud-monitoring-exporter");
    const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
    const { resourceFromAttributes } = require("@opentelemetry/resources");
    const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
    const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");

    const projectId = gcpProject();
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
      traceExporter: new TraceExporter(projectId ? { projectId } : {}),
      // Auto-instrument incoming HTTP + Express so every request gets a server
      // span without per-route wiring. These patch `http`/`express` via
      // require-in-the-middle, so the SDK must start BEFORE those modules are
      // imported — guaranteed by importing this module first in index.ts.
      instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
      metricReader: new PeriodicExportingMetricReader({
        exporter: new MetricExporter(projectId ? { projectId } : {}),
        // Cloud Monitoring rejects writes more frequent than once per minute per
        // time series, so 60s is the minimum sane export interval.
        exportIntervalMillis: 60_000
      })
    });
    sdk.start();
    activeSdk = sdk;
    sdkStarted = true;
    log("info", "telemetry_initialized", { service: SERVICE_NAME, project: projectId });
  } catch (err) {
    // A telemetry init failure must never take down the function.
    log("warn", "telemetry_init_failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    sdkStarted = false;
  }
  return sdkStarted;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!activeSdk) return;
  try {
    await activeSdk.shutdown();
  } catch {
    /* best effort */
  }
}

// --- Instrument caches ------------------------------------------------------
// Instruments are cached by name: OTel warns on duplicate instrument creation,
// and re-creating per call is wasteful. The meter is resolved lazily from the
// global provider so instruments bind to whatever provider is active.

const histograms = new Map<string, Histogram>();
const counters = new Map<string, Counter>();

function meter(): Meter {
  return metrics.getMeter(SERVICE_NAME);
}

function histogram(name: string, unit: string): Histogram {
  let h = histograms.get(name);
  if (!h) {
    h = meter().createHistogram(name, { unit, description: `${name} (${unit})` });
    histograms.set(name, h);
  }
  return h;
}

function counter(name: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = meter().createCounter(name, { description: name });
    counters.set(name, c);
  }
  return c;
}

// Clears cached instruments so a test can rebind to a freshly installed meter
// provider. Intended for tests only.
export function resetTelemetryForTest(): void {
  histograms.clear();
  counters.clear();
}

// --- Public helpers ---------------------------------------------------------

// Record a latency measurement (milliseconds) into a histogram instrument.
// Never throws.
export function recordLatency(metric: string, ms: number, attrs: Attributes = {}): void {
  try {
    histogram(metric, "ms").record(ms, attrs);
  } catch {
    /* telemetry must never break the caller */
  }
}

// Increment a counter instrument (defaults to +1). Never throws.
export function recordCounter(name: string, attrs: Attributes = {}, value = 1): void {
  try {
    counter(name).add(value, attrs);
  } catch {
    /* telemetry must never break the caller */
  }
}

// Run `fn` inside an active span named `name`, recording the span duration as a
// `<name>.duration_ms` latency metric and setting span status. Works for both
// sync and async `fn`; the span ends when a returned promise settles. Returns
// the exact result of `fn`. On throw/rejection the error is recorded on the span
// (via `recordError`) and re-thrown — telemetry never swallows caller errors.
export function startSpan<T>(name: string, fn: (span: Span) => T, attrs: Attributes = {}): T {
  const tracer = trace.getTracer(SERVICE_NAME);
  const start = Date.now();
  return tracer.startActiveSpan(name, { attributes: attrs }, (span: Span): T => {
    const finish = (err?: unknown): void => {
      recordLatency(`${name}.duration_ms`, Date.now() - start, attrs);
      if (err !== undefined) {
        recordError(err, { span: name });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    };

    let result: T;
    try {
      result = fn(span);
    } catch (err) {
      finish(err);
      throw err;
    }

    // Defer span end until an async result settles, otherwise end immediately.
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (result as unknown as Promise<unknown>).then(
        (value) => {
          finish();
          return value;
        },
        (err) => {
          finish(err);
          throw err;
        }
      ) as unknown as T;
    }

    finish();
    return result;
  });
}

// Error-recording hook: the single home for the previously-TODO error sink.
// Records the exception on the current span (if any), increments an
// `errors_total` counter, and surfaces a structured error log. Routes/services
// can adopt this in their catch blocks (see docs/notes/observability.md).
export function recordError(err: unknown, attrs: Attributes = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    }
    counter("errors_total").add(1, { ...attrs, "error.type": e.name });
  } catch {
    /* never let telemetry break the caller */
  }
  // Structured log is the durable sink so errors are captured even when no span
  // / exporter is active (tests, emulator, pre-init cold start).
  log("error", "telemetry_error", { ...attrs, error: e.message, errorType: e.name });
}

// Auto-init on first import. `index.ts` imports this module FIRST (before
// `express`/`http`), so in a real runtime the SDK starts — and patches the
// HTTP/Express modules for auto-instrumentation — before those modules are
// evaluated. Guarded, so it is a hard no-op in tests/emulator.
initTelemetry();
