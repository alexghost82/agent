/**
 * Unit tests — summarizeResource (Epic 1.1). Runs WITHOUT the Firestore emulator
 * by mocking the `./firebase` db, the `./ai` llm/embedding calls and the `./stats`
 * counter. Verifies the structured summary is written as a `chunkType:"summary"`
 * chunk, that dedup is honoured, and that it never throws into the request path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fb = vi.hoisted(() => {
  const query: any = {};
  query.where = vi.fn((..._a: any[]) => query);
  query.limit = vi.fn((..._a: any[]) => query);
  query.get = vi.fn(async () => ({ empty: true, docs: [] as any[] }));
  query.add = vi.fn(async (..._a: any[]) => ({ id: "chunk_1" }));
  const collection = vi.fn((..._a: any[]) => query);
  return { query, collection };
});

const ai = vi.hoisted(() => ({
  llm: vi.fn(async (..._a: any[]) => "Тема: про память агента.\nКлючевые понятия: индексация, эмбеддинги, конспект.\nКраткий вывод: конспект помогает понимать."),
  embedding: vi.fn(async (..._a: any[]) => [0.1, 0.2, 0.3])
}));

vi.mock("../src/firebase", () => ({ db: { collection: fb.collection }, admin: {} }));
vi.mock("../src/ai", () => ({ llm: ai.llm, embedding: ai.embedding }));
vi.mock("../src/stats", () => ({ bumpCounter: vi.fn(async () => {}), COUNTED_COLLECTIONS: [] }));

import { summarizeResource } from "../src/learn";

const baseOpts = {
  userId: "u1",
  topicId: "t1",
  sourceId: "s1",
  sourceUrl: "https://example.com/article",
  title: "Example article",
  text: "This is a sufficiently long resource body that should be summarized into a structured note for the agent's memory."
};

beforeEach(() => {
  vi.clearAllMocks();
  fb.query.get.mockResolvedValue({ empty: true, docs: [] });
  ai.llm.mockResolvedValue(
    "Тема: про память агента.\nКлючевые понятия: индексация, эмбеддинги, конспект.\nКраткий вывод: конспект помогает понимать."
  );
});

describe("summarizeResource (Epic 1.1)", () => {
  it("writes a summary chunk with chunkType=summary and confidence 0.9", async () => {
    const res = await summarizeResource(baseOpts);
    expect(res).toEqual({ saved: true });

    // Asked the model for the gist with a "суть" system prompt.
    expect(ai.llm).toHaveBeenCalledTimes(1);
    expect(String(ai.llm.mock.calls[0][0])).toContain("суть");

    expect(ai.embedding).toHaveBeenCalledTimes(1);
    expect(fb.query.add).toHaveBeenCalledTimes(1);
    const doc = fb.query.add.mock.calls[0][0] as Record<string, unknown>;
    expect(doc.chunkType).toBe("summary");
    expect(doc.confidence).toBe(0.9);
    expect(doc.userId).toBe("u1");
    expect(doc.topicId).toBe("t1");
    expect(doc.sourceId).toBe("s1");
    expect(doc.sourceUrl).toBe("https://example.com/article");
    expect(doc.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(typeof doc.contentHash).toBe("string");
    expect(String(doc.content)).toContain("Тема");
  });

  it("skips writing when an identical summary already exists (dedup)", async () => {
    fb.query.get.mockResolvedValue({ empty: false, docs: [{}] });
    const res = await summarizeResource(baseOpts);
    expect(res).toEqual({ saved: false });
    expect(fb.query.add).not.toHaveBeenCalled();
  });

  it("does nothing for too-short input and never calls the model", async () => {
    const res = await summarizeResource({ ...baseOpts, text: "tiny" });
    expect(res).toEqual({ saved: false });
    expect(ai.llm).not.toHaveBeenCalled();
    expect(fb.query.add).not.toHaveBeenCalled();
  });

  it("never throws into the request path when the model fails (best-effort)", async () => {
    ai.llm.mockRejectedValue(new Error("provider down"));
    const res = await summarizeResource(baseOpts);
    expect(res).toEqual({ saved: false });
    expect(fb.query.add).not.toHaveBeenCalled();
  });
});
