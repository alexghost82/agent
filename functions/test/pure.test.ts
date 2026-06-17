import { describe, it, expect } from "vitest";
import {
  chunkText,
  cosineSimilarity,
  safeJsonArray,
  safeJsonObject,
  parseRepoUrl,
  isTextFile,
  tsMillis
} from "../src/pure";

describe("chunkText", () => {
  it("splits long text into bounded chunks", () => {
    const chunks = chunkText("a ".repeat(3000), 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });
  it("collapses whitespace and drops empties", () => {
    expect(chunkText("   hello    world   ")).toEqual(["hello world"]);
    expect(chunkText("   ")).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("does not divide by zero", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("safeJsonArray", () => {
  it("parses fenced JSON arrays", () => {
    expect(safeJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it("returns [] on garbage", () => {
    expect(safeJsonArray("not json")).toEqual([]);
  });
});

describe("safeJsonObject", () => {
  it("parses embedded objects", () => {
    expect(safeJsonObject('prefix {"x": 2} suffix')).toEqual({ x: 2 });
  });
  it("returns null on garbage", () => {
    expect(safeJsonObject("nope")).toBeNull();
  });
});

describe("parseRepoUrl", () => {
  it("parses https urls", () => {
    expect(parseRepoUrl("https://github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("parses .git and ssh forms", () => {
    expect(parseRepoUrl("git@github.com:acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("parses shorthand", () => {
    expect(parseRepoUrl("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("throws on invalid input", () => {
    expect(() => parseRepoUrl("not a repo")).toThrow();
  });
});

describe("isTextFile", () => {
  it("accepts known code/text files", () => {
    expect(isTextFile("src/index.ts")).toBe(true);
    expect(isTextFile("README.md")).toBe(true);
    expect(isTextFile("Dockerfile")).toBe(true);
  });
  it("rejects binaries", () => {
    expect(isTextFile("logo.png")).toBe(false);
    expect(isTextFile("bin/app")).toBe(false);
  });
});

describe("tsMillis", () => {
  it("supports Timestamp-like shapes", () => {
    expect(tsMillis({ toMillis: () => 1234 })).toBe(1234);
    expect(tsMillis({ _seconds: 2 })).toBe(2000);
    expect(tsMillis(null)).toBe(0);
  });
});
