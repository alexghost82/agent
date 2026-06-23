/**
 * Unit tests — GitHub ingestion DEPTH helpers (src/github.ts).
 *
 * These cover the *pure* file-prioritization / selection logic and the
 * content-aware summary builder. Firestore, the AI layer, and the GitHub REST
 * client are mocked at import time only so that pulling in `src/github.ts`
 * performs no I/O (admin.initializeApp / network are never reached). The tests
 * themselves make zero network calls and exercise only the deterministic
 * helpers `selectFilesForIngest` and `buildSummaryFileContents`.
 */
import { describe, it, expect, vi } from "vitest";

// Avoid admin.initializeApp() and provider wiring at import time.
vi.mock("../src/firebase", () => ({ db: {}, admin: {} }));
vi.mock("../src/ai", () => ({ embeddingBatch: vi.fn(), llm: vi.fn() }));
// Keep the real-shaped constants github.ts reads at module load, no network.
vi.mock("../src/githubFetch", () => ({
  MAX_FILE_BYTES: 100_000,
  MAX_FILE_BYTES_CEILING: 2_000_000,
  getRepoInfo: vi.fn(),
  fetchTree: vi.fn(),
  fetchRawFile: vi.fn()
}));

import { selectFilesForIngest, buildSummaryFileContents, type IngestCandidate } from "../src/github";

const c = (path: string, size: number): IngestCandidate => ({ path, size });

describe("selectFilesForIngest — prioritization", () => {
  it("ranks key root files / manifests / entry points first", () => {
    const files = [
      c("src/utils/random.ts", 10), // tier 2 (plain source), smallest
      c("README.md", 5_000),
      c("package.json", 2_000),
      c("prisma/schema.prisma", 4_000),
      c("src/index.ts", 3_000) // entry point
    ];
    const selected = selectFilesForIngest(files, 10).map((f) => f.path);
    // All four key root files must come before the plain source file, despite
    // the source file being the smallest.
    const rootSet = new Set(["README.md", "package.json", "prisma/schema.prisma", "src/index.ts"]);
    const lastFour = selected.slice(0, 4);
    expect(new Set(lastFour)).toEqual(rootSet);
    expect(selected[selected.length - 1]).toBe("src/utils/random.ts");
  });

  it("prioritizes high-value roles (route/service/config/...) over plain source", () => {
    const files = [
      c("src/misc/helper.ts", 50), // tier 2 source (smallest)
      c("src/routes/users.route.ts", 9_000), // route -> tier 1
      c("src/services/payment.service.ts", 8_000), // service -> tier 1
      c("vite.config.ts", 1_000) // config -> tier 1
    ];
    const selected = selectFilesForIngest(files, 10).map((f) => f.path);
    // The plain source helper ranks last even though it is by far the smallest.
    expect(selected[selected.length - 1]).toBe("src/misc/helper.ts");
    expect(selected.slice(0, 3)).toEqual([
      "vite.config.ts",
      "src/services/payment.service.ts",
      "src/routes/users.route.ts"
    ]);
  });

  it("breaks ties within a tier by smaller-file-first", () => {
    const files = [
      c("src/c.ts", 300),
      c("src/a.ts", 100),
      c("src/b.ts", 200)
    ];
    const selected = selectFilesForIngest(files, 10).map((f) => f.path);
    expect(selected).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("respects the cap and keeps the most important files within it", () => {
    const files = [
      c("src/z1.ts", 10),
      c("src/z2.ts", 11),
      c("src/z3.ts", 12),
      c("package.json", 9_000), // tier 0 — must survive the cap
      c("prisma/schema.prisma", 9_500) // tier 0 — must survive the cap
    ];
    const selected = selectFilesForIngest(files, 2).map((f) => f.path);
    expect(selected).toHaveLength(2);
    expect(new Set(selected)).toEqual(new Set(["package.json", "prisma/schema.prisma"]));
  });

  it("returns an empty array for a non-positive cap", () => {
    const files = [c("package.json", 10), c("src/a.ts", 20)];
    expect(selectFilesForIngest(files, 0)).toEqual([]);
    expect(selectFilesForIngest(files, -5)).toEqual([]);
  });

  it("is deterministic and does not mutate the input array", () => {
    const files = [c("src/b.ts", 200), c("README.md", 50), c("src/a.ts", 100)];
    const snapshot = files.map((f) => f.path);
    const first = selectFilesForIngest(files, 10).map((f) => f.path);
    const second = selectFilesForIngest(files, 10).map((f) => f.path);
    expect(first).toEqual(second);
    expect(files.map((f) => f.path)).toEqual(snapshot);
  });
});

describe("buildSummaryFileContents — content-aware summary input", () => {
  it("includes high-value file contents, skips empty/null, and prefixes FILE:", () => {
    const out = buildSummaryFileContents([
      { path: "src/a.ts", content: "const a = 1;" },
      { path: "package.json", content: '{"name":"x"}' },
      { path: "empty.ts", content: "   " },
      { path: "missing.ts", content: null }
    ]);
    expect(out.included).toContain("package.json");
    expect(out.included).not.toContain("empty.ts");
    expect(out.included).not.toContain("missing.ts");
    expect(out.text).toContain("FILE: package.json");
    // Manifest (tier 0) is ordered before the plain source file (tier 2).
    expect(out.text.indexOf("FILE: package.json")).toBeLessThan(out.text.indexOf("FILE: src/a.ts"));
  });

  it("bounds the total summary input to the char budget", () => {
    const files = Array.from({ length: 40 }, (_v, i) => ({
      path: `src/file${i}.ts`,
      content: "x".repeat(5_000)
    }));
    const out = buildSummaryFileContents(files, 12_000);
    expect(out.text.length).toBeLessThanOrEqual(12_000 + 200);
    expect(out.included.length).toBeLessThan(files.length);
  });
});
