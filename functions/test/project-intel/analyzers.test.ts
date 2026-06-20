// Pure unit tests for the dependency + risk analyzers.
import { describe, it, expect } from "vitest";
import { detectLanguage } from "../../src/pure";
import { classifyFile } from "../../src/project-intelligence/scanner/classify";
import { analyzeDependencies } from "../../src/project-intelligence/analyzers/dependencies";
import { analyzeRisk } from "../../src/project-intelligence/analyzers/risk";
import type { ScannedFile } from "../../src/project-intelligence/types";

function f(path: string, content = "", sizeOverride?: number): ScannedFile {
  return {
    path,
    size: sizeOverride ?? content.length,
    language: detectLanguage(path),
    role: classifyFile(path),
    content
  };
}

describe("analyzeDependencies", () => {
  it("resolves relative imports to internal file edges and records external packages", () => {
    const files = [
      f("a.ts", "import { x } from './b';\nexport const a = 1;"),
      f("b.ts", "import React from 'react';\nexport const b = 2;")
    ];
    const graph = analyzeDependencies(files);

    expect(graph.fileEdges).toContainEqual({ from: "a.ts", to: "b.ts" });
    expect(graph.externalUsage.get("react")).toBeTruthy();
    expect(graph.externalUsage.get("react")!.has("b.ts")).toBe(true);
  });

  it("ignores commented-out imports", () => {
    const files = [
      f("a.ts", "// import { x } from './b';\nexport const a = 1;"),
      f("b.ts", "export const b = 2;")
    ];
    const graph = analyzeDependencies(files);
    expect(graph.fileEdges.length).toBe(0);
  });
});

describe("analyzeRisk", () => {
  it("flags circular dependencies", () => {
    const files = [f("a.ts", "import './b';"), f("b.ts", "import './a';")];
    const graph = analyzeDependencies(files);
    const insights = analyzeRisk(files, graph);
    expect(insights.some((i) => i.kind === "cycle")).toBe(true);
  });

  it("flags very large files as critical", () => {
    const big = f("huge.ts", "x", 90_000);
    const graph = analyzeDependencies([big]);
    const insights = analyzeRisk([big], graph);
    const large = insights.find((i) => i.kind === "god_file" || i.kind === "large_file");
    expect(large).toBeTruthy();
    expect(large!.severity).toBe("critical");
  });

  it("flags committed secret files", () => {
    const files = [f("src/index.ts", "export {}"), f(".env", "")];
    const graph = analyzeDependencies(files);
    const insights = analyzeRisk(files, graph);
    expect(insights.some((i) => i.kind === "secret_risk")).toBe(true);
  });
});
