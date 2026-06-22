/**
 * Unit tests — read-only repository scanner (project-intelligence/scanner).
 *
 * Mocks `../../src/githubFetch` so no network/token is needed and drives the
 * full scanRepo pipeline: exclude-list + non-text + oversize filtering, the
 * secret-file presence-only rule (indexed but content NEVER fetched), priority
 * ordering, the bounded content fetch, and the progress callback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const gh = vi.hoisted(() => ({
  MAX_FILE_BYTES: 1_000_000,
  getRepoInfo: vi.fn(async () => ({ default_branch: "main" })),
  fetchTree: vi.fn(async () => [] as any[]),
  fetchRawFile: vi.fn(async () => "FILE CONTENT")
}));

vi.mock("../../src/githubFetch", () => ({
  MAX_FILE_BYTES: gh.MAX_FILE_BYTES,
  getRepoInfo: gh.getRepoInfo,
  fetchTree: gh.fetchTree,
  fetchRawFile: gh.fetchRawFile
}));

import { scanRepo } from "../../src/project-intelligence/scanner";

beforeEach(() => {
  vi.clearAllMocks();
  gh.getRepoInfo.mockResolvedValue({ default_branch: "main" });
  gh.fetchRawFile.mockResolvedValue("FILE CONTENT");
});

describe("scanRepo (project-intelligence scanner)", () => {
  it("indexes text files, skips junk, and never fetches secret content", async () => {
    gh.fetchTree.mockResolvedValue([
      { type: "blob", path: "src/index.ts", size: 100 },
      { type: "blob", path: "src/routes/api.ts", size: 80 }, // priority role: route
      { type: "blob", path: "credentials.json", size: 50 }, // text + SECRET
      { type: "blob", path: "node_modules/x/a.js", size: 10 }, // excluded dir
      { type: "blob", path: "logo.png", size: 10 }, // not a text file
      { type: "blob", path: "huge.ts", size: gh.MAX_FILE_BYTES + 1 }, // oversize
      { type: "tree", path: "src" } // not a blob
    ]);

    const progress: Array<[number, number]> = [];
    const result = await scanRepo({
      repoUrl: "https://github.com/acme/demo",
      onProgress: async (done, total) => {
        progress.push([done, total]);
      }
    });

    expect(result.branch).toBe("main");
    // 6 blobs in the tree (the "tree" node does not count).
    expect(result.totalTreeFiles).toBe(6);

    // Only the three text, non-excluded, in-size files are indexed.
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(["credentials.json", "src/index.ts", "src/routes/api.ts"]);

    // Secret file: indexed by presence only, content NEVER fetched.
    const secret = result.files.find((f) => f.path === "credentials.json")!;
    expect(secret.content).toBeUndefined();
    const fetched = gh.fetchRawFile.mock.calls.map((c) => c[3]);
    expect(fetched).not.toContain("credentials.json");

    // Non-secret files have their content populated.
    expect(result.files.find((f) => f.path === "src/index.ts")!.content).toBe("FILE CONTENT");
    expect(result.files.find((f) => f.path === "src/routes/api.ts")!.content).toBe("FILE CONTENT");

    // Detected language is wired through from the path.
    expect(result.files.find((f) => f.path === "src/index.ts")!.language).toBe("typescript");

    // Progress callback fired at least once with the final count.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual([2, 2]);

    // Nothing was over the caps here.
    expect(result.truncated).toBe(false);
  });

  it("marks the result truncated when the content cap is exceeded", async () => {
    // 3 fetchable source files but a cap of 1 -> truncated.
    process.env.SCAN_MAX_CONTENT_FILES = "1";
    vi.resetModules();
    gh.fetchTree.mockResolvedValue([
      { type: "blob", path: "a.ts", size: 10 },
      { type: "blob", path: "b.ts", size: 20 },
      { type: "blob", path: "c.ts", size: 30 }
    ]);
    // Re-import with the new env applied at module-eval time.
    const { scanRepo: scanRepoFresh } = await import("../../src/project-intelligence/scanner");
    const result = await scanRepoFresh({ repoUrl: "acme/demo" });
    expect(result.files).toHaveLength(3);
    expect(result.truncated).toBe(true);
    delete process.env.SCAN_MAX_CONTENT_FILES;
  });
});
