import { describe, it, expect } from "vitest";
import { readEmbedding } from "../src/vector";

describe("readEmbedding", () => {
  it("returns a plain array unchanged", () => {
    const arr = [0.1, 0.2, 0.3];
    expect(readEmbedding(arr)).toEqual(arr);
  });

  it("reads a native Firestore vector value via toArray()", () => {
    const vectorValue = { toArray: () => [1, 2, 3] };
    expect(readEmbedding(vectorValue)).toEqual([1, 2, 3]);
  });

  it("returns undefined for missing / unrecognised values", () => {
    expect(readEmbedding(undefined)).toBeUndefined();
    expect(readEmbedding(null)).toBeUndefined();
    expect(readEmbedding({})).toBeUndefined();
    expect(readEmbedding("nope")).toBeUndefined();
  });

  it("returns undefined when toArray throws", () => {
    const bad = {
      toArray: () => {
        throw new Error("boom");
      }
    };
    expect(readEmbedding(bad)).toBeUndefined();
  });
});
