/**
 * Unit tests — embedding dimension normalization (ADR-0008). Runs WITHOUT any
 * network or emulator: providers and Firestore are mocked. Verifies that
 * `normalizeEmbedding` maps any provider dimension to a canonical TARGET_EMBED_DIM
 * (pad / pool + L2-renorm) and that the `embedding()` funnel applies it so both
 * ingestion and query paths get canonical-dim vectors automatically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock provider modules so importing ../src/ai (and calling embedding()) never
// touches the network. Each embedding mock returns a controllable raw vector.
const providers = vi.hoisted(() => ({
  openaiEmbedding: vi.fn(async (_k: string, _t: string) => [] as number[]),
  geminiEmbedding: vi.fn(async (_k: string, _t: string) => [] as number[])
}));

vi.mock("../src/providers/openai", () => ({
  openaiEmbedding: providers.openaiEmbedding,
  openaiEmbeddingBatch: vi.fn(async () => []),
  openaiLlm: vi.fn(async () => ""),
  openaiTest: vi.fn(async () => {})
}));
vi.mock("../src/providers/gemini", () => ({
  geminiEmbedding: providers.geminiEmbedding,
  geminiEmbeddingBatch: vi.fn(async () => []),
  geminiLlm: vi.fn(async () => ""),
  geminiTest: vi.fn(async () => {})
}));
vi.mock("../src/providers/anthropic", () => ({
  anthropicLlm: vi.fn(async () => ""),
  anthropicTest: vi.fn(async () => {})
}));
vi.mock("../src/providers/azure", () => ({
  azureEmbedding: vi.fn(async () => []),
  azureEmbeddingBatch: vi.fn(async () => []),
  azureLlm: vi.fn(async () => ""),
  azureTest: vi.fn(async () => {})
}));

// `resolve()` reads a users doc to pick the provider; return one with a chosen
// aiProvider and no stored key so resolution falls back to the env key.
const fb = vi.hoisted(() => ({
  aiProvider: "openai" as string,
  get: vi.fn(async () => ({ data: () => ({ aiProvider: fb.aiProvider }) }))
}));
vi.mock("../src/firebase", () => ({
  db: { collection: () => ({ doc: () => ({ get: fb.get }) }) },
  admin: {}
}));
vi.mock("../src/crypto", () => ({ decryptSecret: vi.fn(() => "") }));
vi.mock("../src/log", () => ({ log: vi.fn() }));

import { normalizeEmbedding, TARGET_EMBED_DIM, embedding } from "../src/ai";

function l2norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot / ((l2norm(a) * l2norm(b)) || 1);
}
function randomVec(n: number, seed = 1): number[] {
  // Deterministic pseudo-random vector (no Math.random → stable tests).
  let s = seed;
  return Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fb.aiProvider = "openai";
  delete process.env.TARGET_EMBED_DIM;
});

describe("normalizeEmbedding (ADR-0008)", () => {
  it("pads a 768-dim Gemini vector up to 1536 and L2-renormalizes to unit norm", () => {
    const v768 = randomVec(768, 7);
    const out = normalizeEmbedding(v768, 1536);

    expect(out).toHaveLength(1536);
    expect(l2norm(out)).toBeCloseTo(1, 6);
    // The padded tail carries no signal.
    for (let i = 768; i < 1536; i++) expect(out[i]).toBe(0);
    // Cosine between two padded Gemini vectors equals their native cosine
    // (the zero tail never contributes).
    const a = randomVec(768, 11);
    const b = randomVec(768, 29);
    expect(cosine(normalizeEmbedding(a, 1536), normalizeEmbedding(b, 1536))).toBeCloseTo(
      cosine(a, b),
      6
    );
  });

  it("leaves a 1536→1536 vector stable: unit-norm input is returned essentially unchanged", () => {
    // Build an already-unit-norm 1536 vector (mimics OpenAI output).
    const raw = randomVec(1536, 3);
    const unit = raw.map((x) => x / l2norm(raw));

    const out = normalizeEmbedding(unit, 1536);
    expect(out).toHaveLength(1536);
    expect(l2norm(out)).toBeCloseTo(1, 9);
    // L2-renorm of an already-unit vector is a no-op (within float tolerance).
    for (let i = 0; i < 1536; i++) expect(out[i]).toBeCloseTo(unit[i], 9);
  });

  it("preserves cosine for a same-dim, non-normalized vector (renorm is scale-invariant)", () => {
    const a = randomVec(1536, 5);
    const b = randomVec(1536, 17);
    const before = cosine(a, b);
    const after = cosine(normalizeEmbedding(a, 1536), normalizeEmbedding(b, 1536));
    expect(after).toBeCloseTo(before, 6);
  });

  it("reduces an over-long vector by deterministic average-pooling (exact math on small dims)", () => {
    // 4 → 2: bucket 0 = mean(v0,v1), bucket 1 = mean(v2,v3), then L2-renorm.
    const v = [1, 3, 10, 10];
    const out = normalizeEmbedding(v, 2);
    expect(out).toHaveLength(2);

    const pooled = [(1 + 3) / 2, (10 + 10) / 2]; // [2, 10]
    const norm = l2norm(pooled);
    expect(out[0]).toBeCloseTo(pooled[0] / norm, 9);
    expect(out[1]).toBeCloseTo(pooled[1] / norm, 9);
    expect(l2norm(out)).toBeCloseTo(1, 9);
  });

  it("reduces a long even multiple (3072→1536) to unit-norm canonical dim", () => {
    const v = randomVec(3072, 13);
    const out = normalizeEmbedding(v, 1536);
    expect(out).toHaveLength(1536);
    expect(l2norm(out)).toBeCloseTo(1, 6);
  });

  it("returns a zero vector as-is (no NaN) and defaults to the configured TARGET_EMBED_DIM", () => {
    expect(normalizeEmbedding([0, 0, 0], 4)).toEqual([0, 0, 0, 0]);
    // Default target tracks the env-configurable TARGET_EMBED_DIM (default 1536).
    expect(TARGET_EMBED_DIM).toBe(1536);
    expect(normalizeEmbedding(randomVec(10, 2))).toHaveLength(TARGET_EMBED_DIM);
  });
});

describe("embedding() funnel applies normalization (ingestion + query paths)", () => {
  it("canonicalizes a 768-dim Gemini provider result to TARGET_EMBED_DIM, unit-norm", async () => {
    fb.aiProvider = "gemini";
    process.env.GEMINI_API_KEY = "test-key";
    providers.geminiEmbedding.mockResolvedValueOnce(randomVec(768, 41));

    const out = await embedding("hello", "u1");
    expect(providers.geminiEmbedding).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1536);
    expect(l2norm(out)).toBeCloseTo(1, 6);
  });

  it("passes a 1536-dim OpenAI result through at canonical dim", async () => {
    fb.aiProvider = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    providers.openaiEmbedding.mockResolvedValueOnce(randomVec(1536, 53));

    const out = await embedding("hello", "u1");
    expect(providers.openaiEmbedding).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1536);
    expect(l2norm(out)).toBeCloseTo(1, 6);
  });
});
