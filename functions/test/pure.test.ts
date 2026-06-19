import { describe, it, expect } from "vitest";
import {
  chunkText,
  cosineSimilarity,
  safeJsonArray,
  safeJsonObject,
  parseRepoUrl,
  isTextFile,
  tsMillis,
  sanitizeArtifactPath,
  detectLanguage,
  normalizeBuildFiles
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

describe("sanitizeArtifactPath (build, CONTRACT v2.2)", () => {
  it("normalizes safe relative paths", () => {
    expect(sanitizeArtifactPath("src/index.ts")).toBe("src/index.ts");
    expect(sanitizeArtifactPath("/leading/slash.txt")).toBe("leading/slash.txt");
    expect(sanitizeArtifactPath("./a/./b.ts")).toBe("a/b.ts");
    expect(sanitizeArtifactPath("a\\b\\c.ts")).toBe("a/b/c.ts");
  });
  it("rejects traversal, absolute escapes, NUL and non-strings", () => {
    expect(sanitizeArtifactPath("../secret")).toBeNull();
    expect(sanitizeArtifactPath("a/../../etc/passwd")).toBeNull();
    expect(sanitizeArtifactPath("foo\0bar")).toBeNull();
    expect(sanitizeArtifactPath("")).toBeNull();
    expect(sanitizeArtifactPath("/")).toBeNull();
    expect(sanitizeArtifactPath(42 as unknown as string)).toBeNull();
  });
});

describe("detectLanguage (build)", () => {
  it("maps known extensions and filenames", () => {
    expect(detectLanguage("src/app.tsx")).toBe("typescript");
    expect(detectLanguage("main.py")).toBe("python");
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("README.md")).toBe("markdown");
  });
  it("returns null for unknown/extensionless", () => {
    expect(detectLanguage("bin/app")).toBeNull();
    expect(detectLanguage("logo.png")).toBeNull();
  });
});

describe("normalizeBuildFiles (build, CONTRACT v2.2)", () => {
  it("sanitizes, de-dupes, tags language and bytes", () => {
    const files = normalizeBuildFiles(
      [
        { path: "/src/a.ts", content: "export const a = 1;" },
        { path: "src/a.ts", content: "dup ignored" },
        { path: "../evil.ts", content: "nope" },
        { path: "docs/x.md", content: "hi" }
      ],
      40,
      100_000
    );
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "docs/x.md"]);
    expect(files[0].language).toBe("typescript");
    expect(files[0].bytes).toBe(Buffer.byteLength("export const a = 1;", "utf8"));
  });
  it("enforces the file count cap and per-file byte cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.txt`, content: "x".repeat(50) }));
    const capped = normalizeBuildFiles(many, 3, 10);
    expect(capped).toHaveLength(3);
    expect(capped.every((f) => f.bytes <= 10)).toBe(true);
  });
  it("returns [] for non-array / invalid input", () => {
    expect(normalizeBuildFiles(null, 40, 100_000)).toEqual([]);
    expect(normalizeBuildFiles([{ path: 1, content: 2 }], 40, 100_000)).toEqual([]);
  });
});
