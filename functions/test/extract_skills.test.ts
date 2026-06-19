/**
 * Unit tests — extract-skills batch helpers (Epic 2.3). Runs WITHOUT the
 * Firestore emulator by mocking `./firebase`/`./ai`/`./stats` so importing the
 * skills router has no side effects. Verifies the iterative corpus traversal
 * logic: parsing batch outputs and merging/dedup-ing candidates across batches
 * by skillName (so extraction reflects the whole topic, not one 16-chunk slice).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/firebase", () => ({ db: { collection: vi.fn() }, admin: {} }));
vi.mock("../src/ai", () => ({ llm: vi.fn(), embedding: vi.fn() }));
vi.mock("../src/stats", () => ({ bumpCounter: vi.fn(), COUNTED_COLLECTIONS: [] }));

import { parseSkillCandidates, mergeSkillCandidates } from "../src/routes/skills";

describe("parseSkillCandidates (Epic 2.3)", () => {
  it("parses a JSON array (tolerating markdown fences) and normalizes fields", () => {
    const raw =
      "```json\n" +
      JSON.stringify([
        { skillName: "Idempotent Writes", description: "Make writes retryable safely.", example: "e", appliesTo: ["firestore"], template: "t" },
        { skillName: "", description: "no name" },
        { description: "missing name" }
      ]) +
      "\n```";
    const out = parseSkillCandidates(raw);
    expect(out).toHaveLength(1);
    expect(out[0].skillName).toBe("Idempotent Writes");
    expect(out[0].appliesTo).toEqual(["firestore"]);
    expect(out[0].template).toBe("t");
  });

  it("returns [] for non-JSON output", () => {
    expect(parseSkillCandidates("sorry, I cannot help")).toEqual([]);
  });
});

describe("mergeSkillCandidates (Epic 2.3)", () => {
  it("dedups by skillName (case-insensitive) keeping the higher-quality variant", () => {
    const merged = mergeSkillCandidates([
      { skillName: "Caching", description: "short", example: null, appliesTo: ["a"], template: null },
      {
        skillName: "caching",
        description: "A detailed, reusable caching strategy with eviction and TTL handling.",
        example: "use an LRU",
        appliesTo: ["b"],
        template: "const cache = new Map();"
      }
    ]);
    expect(merged).toHaveLength(1);
    // The richer variant wins, and appliesTo is unioned across batches.
    expect(merged[0].description).toContain("detailed");
    expect(merged[0].appliesTo.sort()).toEqual(["a", "b"]);
  });

  it("keeps distinct skills from different batches", () => {
    const merged = mergeSkillCandidates([
      { skillName: "A", description: "first skill description here", example: null, appliesTo: [], template: null },
      { skillName: "B", description: "second skill description here", example: null, appliesTo: [], template: null }
    ]);
    expect(merged.map((c) => c.skillName).sort()).toEqual(["A", "B"]);
  });
});
