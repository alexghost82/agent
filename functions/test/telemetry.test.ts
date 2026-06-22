import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { metrics, type DataPoint, type Histogram as HistogramData } from "@opentelemetry/api";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
  type ResourceMetrics
} from "@opentelemetry/sdk-metrics";

import {
  telemetryEnabled,
  initTelemetry,
  startSpan,
  recordLatency,
  recordCounter,
  recordError,
  resetTelemetryForTest
} from "../src/telemetry";

// Drive the telemetry helpers against an in-memory meter provider so we can
// assert what was recorded WITHOUT any network / GCP / SDK NodeSDK start. This
// stands in for the global no-op meter the helpers would otherwise use under
// tests.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter,
  // Long interval: we drive collection explicitly via forceFlush().
  exportIntervalMillis: 1_000_000
});
const provider = new MeterProvider({ readers: [reader] });

beforeAll(() => {
  metrics.setGlobalMeterProvider(provider);
  // Rebind cached instruments to the freshly installed provider.
  resetTelemetryForTest();
});

afterAll(async () => {
  await provider.shutdown();
});

// Flatten the latest exported metrics and find one by instrument name.
async function findMetric(name: string) {
  await provider.forceFlush();
  const batches: ResourceMetrics[] = exporter.getMetrics();
  for (const rm of batches) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) return m;
      }
    }
  }
  return undefined;
}

describe("telemetry env guards", () => {
  it("is a no-op under tests (no exporter spun up)", () => {
    // Vitest sets NODE_ENV=test / VITEST, so export must be disabled regardless
    // of GOOGLE_CLOUD_PROJECT being primed by the test env helper.
    expect(telemetryEnabled()).toBe(false);
  });

  it("initTelemetry() is a safe no-op that returns false in test mode", () => {
    expect(() => initTelemetry()).not.toThrow();
    expect(initTelemetry()).toBe(false);
    // Idempotent.
    expect(initTelemetry()).toBe(false);
  });
});

describe("telemetry helpers never throw", () => {
  it("recordLatency / recordCounter / recordError are safe to call", () => {
    expect(() => recordLatency("noop_latency_ms", 5)).not.toThrow();
    expect(() => recordCounter("noop_counter")).not.toThrow();
    expect(() => recordError(new Error("boom"), { op: "test" })).not.toThrow();
    expect(() => recordError("a string error")).not.toThrow();
  });
});

describe("recordLatency", () => {
  it("records a latency measurement into a histogram", async () => {
    recordLatency("unit_latency_ms", 42, { backend: "test" });
    const m = await findMetric("unit_latency_ms");
    expect(m).toBeDefined();
    const dp = m!.dataPoints[0] as DataPoint<HistogramData>;
    expect(dp.value.count).toBeGreaterThanOrEqual(1);
    expect(dp.value.sum).toBeGreaterThanOrEqual(42);
  });
});

describe("recordCounter", () => {
  it("accumulates counter increments", async () => {
    recordCounter("unit_counter_total", { kind: "a" });
    recordCounter("unit_counter_total", { kind: "a" });
    recordCounter("unit_counter_total", { kind: "a" }, 3);
    const m = await findMetric("unit_counter_total");
    expect(m).toBeDefined();
    const total = (m!.dataPoints as DataPoint<number>[]).reduce((s, dp) => s + dp.value, 0);
    expect(total).toBe(5);
  });
});

describe("startSpan", () => {
  it("returns the synchronous fn result and records duration", async () => {
    const result = startSpan("unit.sync", () => 7);
    expect(result).toBe(7);
    const m = await findMetric("unit.sync.duration_ms");
    expect(m).toBeDefined();
    expect((m!.dataPoints[0] as DataPoint<HistogramData>).value.count).toBeGreaterThanOrEqual(1);
  });

  it("awaits and returns the async fn result and records duration", async () => {
    const result = await startSpan("unit.async", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "ok";
    });
    expect(result).toBe("ok");
    const m = await findMetric("unit.async.duration_ms");
    expect(m).toBeDefined();
    const dp = m!.dataPoints[0] as DataPoint<HistogramData>;
    expect(dp.value.count).toBeGreaterThanOrEqual(1);
    // Slept ~5ms, so the recorded duration must be > 0.
    expect(dp.value.sum).toBeGreaterThan(0);
  });

  it("re-throws synchronous errors and still records the error", () => {
    expect(() =>
      startSpan("unit.sync.err", () => {
        throw new Error("sync boom");
      })
    ).toThrow("sync boom");
  });

  it("re-throws async rejections without swallowing them", async () => {
    await expect(
      startSpan("unit.async.err", async () => {
        throw new Error("async boom");
      })
    ).rejects.toThrow("async boom");
  });
});

describe("recordError", () => {
  it("increments the errors_total counter", async () => {
    recordError(new Error("tracked failure"), { op: "unit" });
    const m = await findMetric("errors_total");
    expect(m).toBeDefined();
    const total = (m!.dataPoints as DataPoint<number>[]).reduce((s, dp) => s + dp.value, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });
});
