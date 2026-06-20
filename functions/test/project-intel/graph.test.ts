// Pure unit tests for the graph builder: typed nodes/edges, layer tagging and
// referential integrity (no dangling edges).
import { describe, it, expect } from "vitest";
import { detectLanguage } from "../../src/pure";
import { classifyFile } from "../../src/project-intelligence/scanner/classify";
import { analyzeDependencies } from "../../src/project-intelligence/analyzers/dependencies";
import { detectFeatures } from "../../src/project-intelligence/detectors/features";
import { buildGraph } from "../../src/project-intelligence/graph/build";
import type { ScannedFile } from "../../src/project-intelligence/types";

function f(path: string, content = ""): ScannedFile {
  return { path, size: content.length, language: detectLanguage(path), role: classifyFile(path), content };
}

const FILES = [
  f("src/routes/users.ts", "import { userService } from '../services/userService';"),
  f("src/services/userService.ts", "import { User } from '../models/user';"),
  f("src/models/user.ts", "export interface User { id: string }")
];

describe("buildGraph", () => {
  const graph = analyzeDependencies(FILES);
  const features = detectFeatures(FILES);
  const built = buildGraph({
    projectName: "Test",
    files: FILES,
    technologies: [],
    features,
    graph,
    insights: []
  });

  it("creates a project root and typed file nodes", () => {
    expect(built.nodes.some((n) => n.type === "project")).toBe(true);
    expect(built.nodes.some((n) => n.type === "apiRoute")).toBe(true);
    expect(built.nodes.some((n) => n.type === "service")).toBe(true);
    expect(built.nodes.some((n) => n.type === "dbModel")).toBe(true);
  });

  it("classifies the service→model edge as reads_from_db on the data-flow layer", () => {
    const dbEdge = built.edges.find((e) => e.type === "reads_from_db");
    expect(dbEdge).toBeTruthy();
    expect(dbEdge!.layers).toContain("dataFlow");
  });

  it("has no dangling edges (every endpoint is a real node)", () => {
    const ids = new Set(built.nodes.map((n) => n.id));
    for (const e of built.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("synthesizes firebaseFunction + firestoreCollection nodes when Firebase is in the stack", () => {
    const fbFiles = [
      f("functions/src/index.ts", "export const api = onRequest({}, app);"),
      f("functions/src/routes/projects.ts", "await db.collection('projects').add({});")
    ];
    const fb = buildGraph({
      projectName: "FB",
      files: fbFiles,
      technologies: [{ id: "tech-firebase", name: "Firebase", category: "backend", confidence: "high" }],
      features: [],
      graph: analyzeDependencies(fbFiles),
      insights: []
    });
    expect(fb.nodes.some((n) => n.type === "firebaseFunction" && n.label === "api")).toBe(true);
    expect(fb.nodes.some((n) => n.type === "firestoreCollection" && n.label === "projects")).toBe(true);
    expect(fb.edges.some((e) => e.type === "exposes")).toBe(true);
    expect(fb.edges.some((e) => e.type === "writes_to_db")).toBe(true);
  });

  it("does not synthesize Firebase nodes for a non-Firebase stack", () => {
    const noFb = buildGraph({
      projectName: "Plain",
      files: [f("src/index.ts", "export const api = onRequest({}, app);")],
      technologies: [{ id: "tech-react", name: "React", category: "frontend", confidence: "high" }],
      features: [],
      graph: analyzeDependencies([f("src/index.ts", "")]),
      insights: []
    });
    expect(noFb.nodes.some((n) => n.type === "firebaseFunction")).toBe(false);
    expect(noFb.nodes.some((n) => n.type === "firestoreCollection")).toBe(false);
  });

  it("respects the node cap", () => {
    const many = Array.from({ length: 500 }, (_, i) => f(`src/gen/file${i}.ts`, "export const x = 1;"));
    const big = buildGraph({
      projectName: "Big",
      files: many,
      technologies: [],
      features: [],
      graph: analyzeDependencies(many),
      insights: [],
      maxNodes: 200
    });
    // file budget = max(50, maxNodes-120) = 80 file nodes, plus structure nodes.
    expect(big.nodes.length).toBeLessThan(200);
  });
});
