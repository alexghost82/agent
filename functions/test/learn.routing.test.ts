/**
 * Pure unit tests for URL/resource routing + text-file coverage (no network):
 *  - `classifyResourceUrl`: GitHub repo URLs (incl. .git / tree / blob deep
 *    links) → github_repo; gists, raw files, product pages, and non-GitHub URLs
 *    → web.
 *  - `isTextFile`: the newly added extensions and dot/underscore config
 *    filenames are recognized as text.
 */
import { describe, it, expect } from "vitest";
import { classifyResourceUrl, isTextFile } from "../src/pure";

describe("classifyResourceUrl", () => {
  it("classifies a plain github.com repo URL as github_repo with owner/repo", () => {
    expect(classifyResourceUrl("https://github.com/vercel/next.js")).toEqual({
      kind: "github_repo",
      owner: "vercel",
      repo: "next.js"
    });
  });

  it("handles the .git suffix variant", () => {
    expect(classifyResourceUrl("https://github.com/facebook/react.git")).toEqual({
      kind: "github_repo",
      owner: "facebook",
      repo: "react"
    });
  });

  it("handles /tree/<branch> deep links", () => {
    expect(classifyResourceUrl("https://github.com/microsoft/TypeScript/tree/main/src")).toEqual({
      kind: "github_repo",
      owner: "microsoft",
      repo: "TypeScript"
    });
  });

  it("handles /blob/<branch>/<file> deep links", () => {
    expect(classifyResourceUrl("https://github.com/nodejs/node/blob/main/README.md")).toEqual({
      kind: "github_repo",
      owner: "nodejs",
      repo: "node"
    });
  });

  it("accepts www.github.com and trailing slashes / query strings", () => {
    expect(classifyResourceUrl("https://www.github.com/openai/whisper/")).toEqual({
      kind: "github_repo",
      owner: "openai",
      repo: "whisper"
    });
    expect(classifyResourceUrl("https://github.com/openai/whisper?tab=readme-ov-file")).toEqual({
      kind: "github_repo",
      owner: "openai",
      repo: "whisper"
    });
  });

  it("treats gist URLs as web (single-file content, not a repo)", () => {
    expect(classifyResourceUrl("https://gist.github.com/someone/abc123def456")).toEqual({ kind: "web" });
  });

  it("treats raw.githubusercontent.com single files as web", () => {
    expect(
      classifyResourceUrl("https://raw.githubusercontent.com/owner/repo/main/file.ts")
    ).toEqual({ kind: "web" });
  });

  it("treats GitHub product / non-repo pages as web", () => {
    expect(classifyResourceUrl("https://github.com/features")).toEqual({ kind: "web" });
    expect(classifyResourceUrl("https://github.com/settings/profile")).toEqual({ kind: "web" });
    expect(classifyResourceUrl("https://github.com/orgs/github")).toEqual({ kind: "web" });
    expect(classifyResourceUrl("https://github.com/vercel")).toEqual({ kind: "web" });
  });

  it("treats ordinary web pages and invalid input as web", () => {
    expect(classifyResourceUrl("https://example.com/docs/guide")).toEqual({ kind: "web" });
    expect(classifyResourceUrl("https://developer.mozilla.org/en-US/docs/Web")).toEqual({ kind: "web" });
    expect(classifyResourceUrl("not a url")).toEqual({ kind: "web" });
    expect(classifyResourceUrl("")).toEqual({ kind: "web" });
  });
});

describe("isTextFile — extended coverage", () => {
  const newExtensions = [
    "notebook.ipynb", "service.proto", "main.tf", "vars.tfvars", "infra.hcl",
    "app.cfg", "nginx.conf", "app.properties", "Contract.sol", "analysis.r",
    "matrix.m", "AppDelegate.mm", "main.dart", "init.lua", "mod.ex", "test.exs",
    "node.erl", "core.clj", "ui.cljs", "config.edn", "Build.scala", "bench.jl",
    "data.tsv", "rows.csv", "intro.rst", "doc.adoc", "build.mk", "CMakeLists.cmake",
    "settings.editorconfig"
  ];

  it.each(newExtensions)("recognizes %s as a text file", (path) => {
    expect(isTextFile(path)).toBe(true);
  });

  const configFilenames = [
    ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc", ".editorconfig",
    ".babelrc", ".dockerignore", "GNUmakefile", "CMakeLists.txt",
    "nested/dir/.eslintrc"
  ];

  it.each(configFilenames)("recognizes config file %s as text", (path) => {
    expect(isTextFile(path)).toBe(true);
  });

  it("still recognizes the pre-existing entries (no regression)", () => {
    expect(isTextFile("src/index.ts")).toBe(true);
    expect(isTextFile("README.md")).toBe(true);
    expect(isTextFile("Dockerfile")).toBe(true);
    expect(isTextFile("schema.prisma")).toBe(true);
  });

  it("returns false for clearly non-text/binary files", () => {
    expect(isTextFile("image.png")).toBe(false);
    expect(isTextFile("archive.zip")).toBe(false);
    expect(isTextFile("binary")).toBe(false);
  });
});
