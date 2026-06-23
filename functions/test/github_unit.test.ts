/**
 * Unit tests — repository ingestion orchestrator (src/github.ts > ingestRepo).
 *
 * Firestore, the AI layer, and the GitHub REST client are all mocked, so this
 * exercises the orchestration logic (filtering, idempotent re-index delete,
 * bounded fetch, chunk/embed/write batching, progress reporting, summary) with
 * zero I/O and no emulator. The real pure/concurrency/util helpers run as-is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const gh = vi.hoisted(() => ({
  getRepoInfo: vi.fn(),
  fetchTree: vi.fn(),
  fetchRawFile: vi.fn()
}));

const aiMock = vi.hoisted(() => ({
  embeddingBatch: vi.fn(),
  llm: vi.fn()
}));

const store = vi.hoisted(() => {
  const state = {
    existingDocs: [] as { ref: string }[],
    deletedRefs: [] as unknown[],
    setDocs: [] as { ref: unknown; data: any }[],
    commits: 0
  };
  let docCounter = 0;
  const query = {
    where: () => query,
    limit: () => query,
    get: vi.fn(async () => ({ docs: state.existingDocs }))
  };
  const db = {
    collection: vi.fn(() => ({
      where: () => query,
      doc: () => ({ id: `doc-${docCounter++}` })
    })),
    batch: vi.fn(() => ({
      delete: (ref: unknown) => state.deletedRefs.push(ref),
      set: (ref: unknown, data: any) => state.setDocs.push({ ref, data }),
      commit: vi.fn(async () => {
        state.commits += 1;
      })
    }))
  };
  return { state, db };
});

vi.mock("../src/firebase", () => ({ db: store.db, admin: {} }));
vi.mock("../src/githubFetch", () => ({
  MAX_FILE_BYTES: 100_000,
  getRepoInfo: gh.getRepoInfo,
  fetchTree: gh.fetchTree,
  fetchRawFile: gh.fetchRawFile
}));
vi.mock("../src/ai", () => ({ embeddingBatch: aiMock.embeddingBatch, llm: aiMock.llm }));

import { ingestRepo } from "../src/github";
import { readEmbedding } from "../src/vector";

beforeEach(() => {
  vi.clearAllMocks();
  store.state.existingDocs = [];
  store.state.deletedRefs = [];
  store.state.setDocs = [];
  store.state.commits = 0;
  aiMock.embeddingBatch.mockImplementation(async (inputs: string[]) => inputs.map(() => [0.1, 0.2]));
  aiMock.llm.mockResolvedValue("PROJECT SUMMARY");
});

describe("ingestRepo", () => {
  it("filters non-text/oversize/non-blob nodes, deletes prior chunks, embeds and summarizes", async () => {
    gh.getRepoInfo.mockResolvedValue({ default_branch: "dev" });
    gh.fetchTree.mockResolvedValue([
      { path: "src/a.ts", type: "blob", size: 100 },
      { path: "logo.png", type: "blob", size: 50 }, // not a text file -> filtered
      { path: "huge.ts", type: "blob", size: 200_000 }, // over MAX_FILE_BYTES -> filtered
      { path: "src", type: "tree" } // not a blob -> filtered
    ]);
    gh.fetchRawFile.mockResolvedValue("const value = 42;\nexport default value;\n");
    store.state.existingDocs = [{ ref: "old-1" }, { ref: "old-2" }];

    const onProgress = vi.fn(async () => {});
    const res = await ingestRepo({
      userId: "u1",
      projectId: "p1",
      repoUrl: "https://github.com/acme/widgets",
      token: "tok",
      onProgress
    });

    expect(res.branch).toBe("dev");
    expect(res.filesIndexed).toBe(1);
    expect(res.chunks).toBeGreaterThan(0);
    expect(res.summary).toBe("PROJECT SUMMARY");

    // Only the single qualifying text file was fetched.
    expect(gh.fetchRawFile).toHaveBeenCalledTimes(1);
    expect(gh.fetchRawFile).toHaveBeenCalledWith("acme", "widgets", "dev", "src/a.ts", "tok");

    // Idempotent re-index removed the previously stored chunks.
    expect(store.state.deletedRefs).toEqual(["old-1", "old-2"]);

    // Chunks were embedded and written.
    expect(aiMock.embeddingBatch).toHaveBeenCalled();
    expect(store.state.setDocs.length).toBe(res.chunks);
    expect(store.state.setDocs[0].data).toMatchObject({
      userId: "u1",
      projectId: "p1",
      scope: "project",
      chunkType: "code"
    });
    // Embeddings are stored as native Firestore vector values now.
    expect(readEmbedding(store.state.setDocs[0].data.embedding)).toEqual([0.1, 0.2]);

    // Final progress report fired.
    expect(onProgress).toHaveBeenCalled();
  });

  it("defaults the branch to main, skips blank files, and tolerates progress-write failures", async () => {
    gh.getRepoInfo.mockResolvedValue({}); // no default_branch
    gh.fetchTree.mockResolvedValue([
      { path: "empty.ts", type: "blob", size: 10 },
      { path: "good.md", type: "blob", size: 20 }
    ]);
    gh.fetchRawFile.mockImplementation(async (_o, _r, _b, path: string) =>
      path === "empty.ts" ? "   " : "# Title\n\nReal documentation content here.\n"
    );

    // onProgress throws — ingest must swallow + log, never reject.
    const onProgress = vi.fn(async () => {
      throw new Error("firestore write failed");
    });

    const res = await ingestRepo({
      userId: "u2",
      projectId: "p2",
      repoUrl: "acme/docs",
      onProgress
    });

    expect(res.branch).toBe("main");
    expect(res.filesIndexed).toBe(1); // empty.ts skipped (blank content)
    expect(res.summary).toBe("PROJECT SUMMARY");
  });

  it("reports progress every 10 fetched files", async () => {
    gh.getRepoInfo.mockResolvedValue({ default_branch: "main" });
    const tree = Array.from({ length: 12 }, (_v, i) => ({
      path: `f${i}.ts`,
      type: "blob",
      size: 30
    }));
    gh.fetchTree.mockResolvedValue(tree);
    gh.fetchRawFile.mockResolvedValue("const a = 1;\n");

    const onProgress = vi.fn(async () => {});
    const res = await ingestRepo({
      userId: "u3",
      projectId: "p3",
      repoUrl: "https://github.com/acme/many.git",
      onProgress
    });

    expect(res.filesIndexed).toBe(12);
    // At least the mid-run (10th file) report plus the final report.
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onProgress).toHaveBeenLastCalledWith(12, 12);
  });

  it("treats nodes without a size as zero bytes and tolerates non-Error progress rejections", async () => {
    gh.getRepoInfo.mockResolvedValue({ default_branch: "main" });
    // No `size` field -> the `n.size ?? 0` nullish branches must treat it as 0.
    gh.fetchTree.mockResolvedValue([{ path: "a.ts", type: "blob" }]);
    gh.fetchRawFile.mockResolvedValue("export const x = 1;\n");

    const onProgress = vi.fn(async () => {
      throw "string failure"; // non-Error rejection -> String(err) branch
    });

    const res = await ingestRepo({
      userId: "u5",
      projectId: "p5",
      repoUrl: "acme/nosize",
      onProgress
    });
    expect(res.filesIndexed).toBe(1);
  });

  it("runs without an onProgress callback", async () => {
    gh.getRepoInfo.mockResolvedValue({ default_branch: "main" });
    gh.fetchTree.mockResolvedValue([{ path: "a.ts", type: "blob", size: 10 }]);
    gh.fetchRawFile.mockResolvedValue("export const x = 1;\n");

    const res = await ingestRepo({
      userId: "u4",
      projectId: "p4",
      repoUrl: "acme/solo"
    });
    expect(res.filesIndexed).toBe(1);
  });
});
