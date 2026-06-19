/**
 * Unit tests — gatherContext / mergeContext (Epic 2.1). Runs WITHOUT the
 * Firestore emulator by mocking the `./firebase` db and the `./ai` embedding so
 * the in-memory cosine index returns a deterministic candidate set. Verifies:
 *   - several subqueries merge with dedup by id,
 *   - chunkType==="summary" chunks float to the front,
 *   - maxChunks and charBudget bounds are honoured.
 * Also unit-tests the pure mergeContext directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Fixed candidate docs returned for every search (same scope → same docs), so
// running N subqueries exercises the dedup-by-id path. Distinct embeddings give
// distinct cosine scores so within-group ordering is testable.
const DOCS = [
  { id: "a", data: () => ({ content: "AAAAAAAAAA", chunkType: "fact", embedding: [1, 0, 0] }) },
  { id: "b", data: () => ({ content: "BBBBBBBBBB", chunkType: "fact", embedding: [0.9, 0.1, 0] }) },
  { id: "s", data: () => ({ content: "SSSSSSSSSS", chunkType: "summary", embedding: [0.5, 0.5, 0] }) },
  { id: "c", data: () => ({ content: "CCCCCCCCCC", chunkType: "fact", embedding: [0, 1, 0] }) }
];

const fb = vi.hoisted(() => {
  const query: any = {};
  query.where = vi.fn((..._a: any[]) => query);
  query.limit = vi.fn((..._a: any[]) => query);
  query.get = vi.fn(async () => ({ size: 4, docs: DOCS as any[] }));
  const collection = vi.fn((..._a: any[]) => query);
  return { query, collection };
});

const ai = vi.hoisted(() => ({
  // Query text is irrelevant to the stored embeddings; a fixed query vector
  // keeps each doc's cosine score deterministic.
  embedding: vi.fn(async (..._a: any[]) => [1, 0, 0])
}));

vi.mock("../src/firebase", () => ({ db: { collection: fb.collection }, admin: {} }));
vi.mock("../src/ai", () => ({ embedding: ai.embedding }));

import { gatherContext, mergeContext, type ScoredChunk } from "../src/memory";

beforeEach(() => {
  vi.clearAllMocks();
  fb.query.get.mockResolvedValue({ size: 4, docs: DOCS });
});

const scope = { userId: "u1", topicId: "t1" };

describe("mergeContext (pure)", () => {
  const make = (id: string, score: number, chunkType: string, content = "x".repeat(10)): ScoredChunk => ({
    id,
    content,
    chunkType,
    score
  });

  it("dedups by id keeping the highest score", () => {
    const out = mergeContext([make("a", 0.2, "fact"), make("a", 0.9, "fact"), make("b", 0.5, "fact")]);
    expect(out.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(out.find((c) => c.id === "a")!.score).toBe(0.9);
  });

  it("floats summary chunks to the front, then orders by score", () => {
    const out = mergeContext([
      make("a", 0.9, "fact"),
      make("b", 0.4, "fact"),
      make("s", 0.1, "summary")
    ]);
    expect(out[0].id).toBe("s");
    expect(out.slice(1).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("honours maxChunks", () => {
    const out = mergeContext(
      [make("a", 0.9, "fact"), make("b", 0.5, "fact"), make("c", 0.1, "fact")],
      { maxChunks: 2 }
    );
    expect(out).toHaveLength(2);
  });

  it("honours charBudget (drops the tail past the budget)", () => {
    const out = mergeContext(
      [make("a", 0.9, "fact", "x".repeat(10)), make("b", 0.5, "fact", "y".repeat(10))],
      { charBudget: 15 }
    );
    // First chunk always allowed; second (10+10>15) is dropped.
    expect(out).toHaveLength(1);
  });

  it("always lets at least one oversized chunk through", () => {
    const out = mergeContext([make("a", 0.9, "fact", "x".repeat(999))], { charBudget: 10 });
    expect(out).toHaveLength(1);
  });
});

describe("gatherContext (mocked firebase + ai)", () => {
  it("merges several subqueries with dedup and summary-first ordering", async () => {
    const out = await gatherContext(["q1", "q2", "q3"], scope);
    // 3 subqueries × 4 docs collapse to 4 unique ids.
    expect(out).toHaveLength(4);
    expect(new Set(out.map((c) => c.id)).size).toBe(4);
    // Summary chunk leads.
    expect(out[0].id).toBe("s");
    // Each subquery issued its own search (embedding called per query).
    expect(ai.embedding).toHaveBeenCalledTimes(3);
  });

  it("accepts a single string query", async () => {
    const out = await gatherContext("just one", scope);
    expect(out).toHaveLength(4);
    expect(ai.embedding).toHaveBeenCalledTimes(1);
  });

  it("honours maxChunks across the merged set", async () => {
    const out = await gatherContext(["q1", "q2"], scope, { maxChunks: 2 });
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("s");
  });

  it("honours charBudget across the merged set", async () => {
    // Each doc content is 10 chars; budget 15 keeps only the first.
    const out = await gatherContext(["q1", "q2"], scope, { charBudget: 15 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("s");
  });

  it("returns [] for an empty / whitespace-only query set", async () => {
    expect(await gatherContext([], scope)).toEqual([]);
    expect(await gatherContext(["   ", ""], scope)).toEqual([]);
    expect(ai.embedding).not.toHaveBeenCalled();
  });
});
