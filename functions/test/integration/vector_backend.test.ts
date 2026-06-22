/**
 * Vector backend selection + fallback tests (feature/vector-backend).
 *
 * Two layers:
 *   1. Pure selection-policy assertions (always run) — they cover the new
 *      "firestore is the default, emulator falls back to memory" semantics of
 *      `selectVectorBackend` WITHOUT touching pure.test.ts (not owned here).
 *   2. Emulator-gated integration assertions — they self-skip when no Firestore
 *      emulator is available, matching the repo convention (see helpers/harness
 *      and integration/memory.test.ts):
 *        (a) under the emulator `makeIndex()` auto-selects the in-memory backend
 *            and ranks chunks end-to-end against real emulator data;
 *        (b) when a `findNearest` query throws, retrieval falls back to the
 *            in-memory cosine path for that request instead of hard-failing.
 */
import { describe, it, expect, vi } from "vitest";

// Importing the harness first primes GCLOUD_PROJECT (via helpers/env) before any
// src/firebase initialisation runs.
import { EMULATOR_AVAILABLE, addDoc, uid } from "../helpers/harness";
import { selectVectorBackend } from "../../src/pure";
import {
  InMemoryCosineIndex,
  FirestoreVectorIndex,
  isEmulator,
  makeIndex,
  type SearchScope,
  type ScoredChunk
} from "../../src/memory";

describe("vector backend selection policy (CONTRACT v3.2, firestore-default)", () => {
  it("defaults to firestore in a real runtime when VECTOR_BACKEND is unset", () => {
    expect(selectVectorBackend(undefined, { emulator: false })).toBe("firestore");
    expect(selectVectorBackend("anything", { emulator: false })).toBe("firestore");
  });

  it("auto-falls back to memory under the emulator", () => {
    expect(selectVectorBackend(undefined, { emulator: true })).toBe("memory");
  });

  it("honours an explicit memory opt-out even outside the emulator", () => {
    expect(selectVectorBackend("memory", { emulator: false })).toBe("memory");
  });

  it("honours an explicit firestore opt-in (explicit wins over emulator)", () => {
    expect(selectVectorBackend("firestore", { emulator: true })).toBe("firestore");
  });

  it("keeps the conservative pure mapping when no runtime context is given", () => {
    // This mirrors the legacy contract still asserted by pure.test.ts.
    expect(selectVectorBackend(undefined)).toBe("memory");
    expect(selectVectorBackend("anything")).toBe("memory");
    expect(selectVectorBackend("firestore")).toBe("firestore");
  });
});

describe.skipIf(!EMULATOR_AVAILABLE)("integration: vector backend (emulator)", () => {
  it("(a) auto-selects the in-memory backend under the emulator and ranks end-to-end", async () => {
    expect(isEmulator()).toBe(true);

    const idx = makeIndex();
    expect(idx).toBeInstanceOf(InMemoryCosineIndex);

    const userId = uid("vec");
    const scope: SearchScope = { userId };
    const near = await addDoc("knowledge_chunks", {
      userId, scope: "topic", title: "near", content: "near", embedding: [1, 0, 0], contentHash: "a_near"
    });
    const mid = await addDoc("knowledge_chunks", {
      userId, scope: "topic", title: "mid", content: "mid", embedding: [0, 1, 0], contentHash: "a_mid"
    });
    const far = await addDoc("knowledge_chunks", {
      userId, scope: "topic", title: "far", content: "far", embedding: [0, 0, 1], contentHash: "a_far"
    });

    // Query vector closest to `near`. searchWithEmbedding bypasses the live
    // embedding provider so the e2e ranking is deterministic and network-free.
    const results = await (idx as InMemoryCosineIndex).searchWithEmbedding([0.9, 0.1, 0], scope, 3);

    expect(results.map((r) => r.id)).toEqual([near, mid, far]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it("(b) falls back to the in-memory cosine path when findNearest throws", async () => {
    const userId = uid("vec");
    const scope: SearchScope = { userId };
    const near = await addDoc("knowledge_chunks", {
      userId, scope: "topic", title: "near", content: "near", embedding: [1, 0, 0], contentHash: "b_near"
    });
    const far = await addDoc("knowledge_chunks", {
      userId, scope: "topic", title: "far", content: "far", embedding: [0, 0, 1], contentHash: "b_far"
    });

    const QUERY_VECTOR = [0.95, 0.05, 0];

    // Subclass overrides the two seams: a deterministic query embedding and a
    // forced findNearest failure. The real `search` catch/log/fallback logic is
    // exercised unchanged.
    class StubFirestoreIndex extends FirestoreVectorIndex {
      protected embedQuery(): Promise<number[]> {
        return Promise.resolve(QUERY_VECTOR);
      }
      protected async runFindNearest(): Promise<ScoredChunk[]> {
        throw new Error("findNearest unsupported (simulated index-not-ready)");
      }
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await new StubFirestoreIndex().search("ignored-query", scope, 2);

      // Results came from the in-memory fallback and are correctly ranked.
      expect(results.length).toBe(2);
      expect(results[0].id).toBe(near);
      expect(results[1].id).toBe(far);
      expect(results[0].score).toBeGreaterThan(results[1].score);

      // A structured warning was emitted for the fallback.
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("vector_findnearest_fallback_inmemory");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
