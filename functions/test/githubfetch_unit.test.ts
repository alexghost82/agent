/**
 * Unit tests — read-only GitHub REST helpers (src/githubFetch.ts).
 * Every request is an HTTP GET; we stub global fetch so no network calls or
 * tokens are needed. Covers header construction, HTTP error -> AppError mapping,
 * raw-file truncation, and the repo-info / tree wrappers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GITHUB_API,
  MAX_FILE_BYTES,
  githubHeaders,
  githubGetJson,
  fetchRawFile,
  getRepoInfo,
  fetchTree
} from "../src/githubFetch";
import { AppError } from "../src/errors";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function textResponse(status: number, text: string) {
  return new Response(text, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubHeaders", () => {
  it("sets the read-only User-Agent and API version, without auth by default", () => {
    const h = githubHeaders();
    expect(h["User-Agent"]).toContain("read-only");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(h.Accept).toBe("application/vnd.github+json");
    expect(h.Authorization).toBeUndefined();
  });

  it("adds a Bearer Authorization header when a token is supplied", () => {
    expect(githubHeaders("tok123").Authorization).toBe("Bearer tok123");
  });
});

describe("githubGetJson error mapping", () => {
  it("returns parsed JSON on success", async () => {
    const f = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    vi.stubGlobal("fetch", f);
    await expect(githubGetJson("/repos/a/b", "tok")).resolves.toEqual({ ok: true });
    expect(String(f.mock.calls[0][0])).toBe(`${GITHUB_API}/repos/a/b`);
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("maps 404 to github_repo_unavailable (400)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(404, {}))));
    const err = await githubGetJson("/x").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("github_repo_unavailable");
    expect(err.status).toBe(400);
  });

  it("maps 401 to github_access_denied (403)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(401, {}))));
    const err = await githubGetJson("/x").catch((e) => e);
    expect(err.code).toBe("github_access_denied");
    expect(err.status).toBe(403);
  });

  it("maps 403 to github_access_denied", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(403, {}))));
    const err = await githubGetJson("/x").catch((e) => e);
    expect(err.code).toBe("github_access_denied");
  });

  it("maps other non-2xx to github_api_error (502)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(500, {}))));
    const err = await githubGetJson("/x").catch((e) => e);
    expect(err.code).toBe("github_api_error");
    expect(err.status).toBe(502);
  });
});

describe("fetchRawFile", () => {
  it("requests the raw Accept header and URL-encodes path segments", async () => {
    const f = vi.fn(() => Promise.resolve(textResponse(200, "file body")));
    vi.stubGlobal("fetch", f);
    const out = await fetchRawFile("owner", "repo", "main", "src/a b/файл.ts", "tok");
    expect(out).toBe("file body");
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/repos/owner/repo/contents/src/a%20b/");
    expect(url).toContain("ref=main");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Accept: "application/vnd.github.raw"
    });
  });

  it("returns null when the file is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(textResponse(404, "nope"))));
    expect(await fetchRawFile("o", "r", "main", "missing.ts")).toBeNull();
  });

  it("truncates content to MAX_FILE_BYTES", async () => {
    const big = "x".repeat(MAX_FILE_BYTES + 500);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(textResponse(200, big))));
    const out = await fetchRawFile("o", "r", "main", "big.ts");
    expect(out).toHaveLength(MAX_FILE_BYTES);
  });
});

describe("getRepoInfo / fetchTree", () => {
  it("getRepoInfo calls the repo endpoint and returns metadata", async () => {
    const f = vi.fn(() => Promise.resolve(jsonResponse(200, { default_branch: "develop" })));
    vi.stubGlobal("fetch", f);
    const info = await getRepoInfo("o", "r");
    expect(info.default_branch).toBe("develop");
    expect(String(f.mock.calls[0][0])).toBe(`${GITHUB_API}/repos/o/r`);
  });

  it("fetchTree returns the recursive tree nodes", async () => {
    const f = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { tree: [{ path: "a.ts", type: "blob", size: 10 }] })
      )
    );
    vi.stubGlobal("fetch", f);
    const tree = await fetchTree("o", "r", "main");
    expect(tree).toEqual([{ path: "a.ts", type: "blob", size: 10 }]);
    expect(String(f.mock.calls[0][0])).toContain("/git/trees/main?recursive=1");
  });

  it("fetchTree returns an empty array when the tree key is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, {}))));
    expect(await fetchTree("o", "r", "main")).toEqual([]);
  });
});
