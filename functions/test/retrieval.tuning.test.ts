/**
 * Unit tests — configurable retrieval / merge limits (feat/retrieval-tuning).
 *
 * Pure, Firestore-free tests for `mergeContext`'s env-configurable defaults:
 *   - env vars `CONTEXT_MAX_CHUNKS` / `CONTEXT_CHAR_BUDGET` drive the defaults,
 *   - explicit caller opts always take precedence over env,
 *   - the "always allow at least one chunk" rule holds regardless of budget,
 *   - defaults match the historical hard-coded values when env is unset.
 *
 * The limits are read at CALL-TIME inside `mergeContext`, so we can toggle
 * process.env between calls. Env is snapshotted/restored around each test so the
 * suite never leaks config into sibling tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mergeContext, type ScoredChunk } from "../src/memory";

const TUNING_ENV = ["CONTEXT_MAX_CHUNKS", "CONTEXT_CHAR_BUDGET", "CONTEXT_PER_QUERY"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of TUNING_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TUNING_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const make = (id: string, score: number, chunkType: string, content = "x".repeat(10)): ScoredChunk => ({
  id,
  content,
  chunkType,
  score
});

describe("mergeContext — CONTEXT_MAX_CHUNKS", () => {
  it("defaults to 40 when env is unset", () => {
    const input = Array.from({ length: 45 }, (_, i) => make(`f${i}`, 45 - i, "fact", "x"));
    expect(mergeContext(input)).toHaveLength(40);
  });

  it("honours the env override", () => {
    process.env.CONTEXT_MAX_CHUNKS = "3";
    const input = Array.from({ length: 10 }, (_, i) => make(`f${i}`, 10 - i, "fact", "x"));
    expect(mergeContext(input)).toHaveLength(3);
  });

  it("lets an explicit opt take precedence over env", () => {
    process.env.CONTEXT_MAX_CHUNKS = "2";
    const input = Array.from({ length: 10 }, (_, i) => make(`f${i}`, 10 - i, "fact", "x"));
    expect(mergeContext(input, { maxChunks: 5 })).toHaveLength(5);
  });

  it("ignores a non-positive / non-numeric env value and falls back to 40", () => {
    process.env.CONTEXT_MAX_CHUNKS = "not-a-number";
    const input = Array.from({ length: 45 }, (_, i) => make(`f${i}`, 45 - i, "fact", "x"));
    expect(mergeContext(input)).toHaveLength(40);

    process.env.CONTEXT_MAX_CHUNKS = "0";
    expect(mergeContext(input)).toHaveLength(40);
  });
});

describe("mergeContext — CONTEXT_CHAR_BUDGET", () => {
  it("defaults to 16000 when env is unset", () => {
    // Two 10-char chunks well under the 16000 default → both kept.
    const out = mergeContext([make("a", 0.9, "fact"), make("b", 0.5, "fact")]);
    expect(out).toHaveLength(2);
  });

  it("honours the env override (drops the tail past the budget)", () => {
    process.env.CONTEXT_CHAR_BUDGET = "15";
    const out = mergeContext([make("a", 0.9, "fact"), make("b", 0.5, "fact")]);
    // First chunk always allowed; second (10+10>15) dropped.
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
  });

  it("lets an explicit opt take precedence over env", () => {
    process.env.CONTEXT_CHAR_BUDGET = "15";
    const out = mergeContext([make("a", 0.9, "fact"), make("b", 0.5, "fact")], { charBudget: 100 });
    expect(out).toHaveLength(2);
  });

  it("always allows at least one chunk through even when it exceeds the env budget", () => {
    process.env.CONTEXT_CHAR_BUDGET = "10";
    const out = mergeContext([make("a", 0.9, "fact", "x".repeat(999))]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
  });

  it("ignores a non-positive / non-numeric env value and falls back to 16000", () => {
    process.env.CONTEXT_CHAR_BUDGET = "garbage";
    const out = mergeContext([make("a", 0.9, "fact"), make("b", 0.5, "fact")]);
    expect(out).toHaveLength(2);
  });
});

describe("mergeContext — env limits compose with ranking", () => {
  it("keeps summary-first ordering while applying the env maxChunks cap", () => {
    process.env.CONTEXT_MAX_CHUNKS = "2";
    const out = mergeContext([
      make("a", 0.9, "fact"),
      make("b", 0.4, "fact"),
      make("s", 0.1, "summary")
    ]);
    expect(out).toHaveLength(2);
    // Summary still floats to the front before the cap is applied.
    expect(out[0].id).toBe("s");
    expect(out[1].id).toBe("a");
  });
});
