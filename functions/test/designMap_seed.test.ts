/**
 * Pure unit tests for the design-map seeder's translation of a Project
 * Intelligence scan graph into design-map nodes/edges
 * (designMap/initialMap.ts::buildDesignMapFromScanGraph) plus the thin
 * project-field fallback (buildInitialDesignMap).
 *
 * Deterministic, no Firebase / network: covers the type + edge mapping, the
 * folding of the intel project node into the design root, non-overlapping
 * layout, the node cap, and that the fallback seed is used when there is no
 * graph.
 */
import { describe, it, expect } from "vitest";
import {
  buildDesignMapFromScanGraph,
  buildInitialDesignMap,
  type InitialMapProject,
  type ScanGraphInput
} from "../src/designMap/initialMap";

const project: InitialMapProject = {
  id: "proj-1",
  name: "Demo",
  description: "A demo project",
  skillIds: ["s1", "s2"]
};

// A representative slice of the intel graph: a project root that owns a feature,
// the feature owning a module, the module using an external package + reading a
// db model, plus an apiRoute, a component and a bulk file node.
const graph: ScanGraphInput = {
  nodes: [
    { id: "project-root", type: "project", label: "Demo", description: "Root of Demo." },
    { id: "feat-auth", type: "feature", label: "Auth", description: "Authentication", confidence: "high" },
    { id: "mod-routes", type: "module", label: "src/routes", description: "Routes", confidence: "high" },
    { id: "route-login", type: "apiRoute", label: "login.ts", description: "Login route" },
    { id: "model-user", type: "dbModel", label: "User", description: "User model" },
    { id: "col-users", type: "firestoreCollection", label: "users" },
    { id: "svc-auth", type: "service", label: "authService.ts" },
    { id: "cmp-button", type: "component", label: "Button.tsx" },
    { id: "file-x", type: "file", label: "helpers.ts" },
    { id: "pkg-express", type: "externalPackage", label: "express" }
  ],
  edges: [
    { id: "e1", source: "project-root", target: "feat-auth", type: "owns" },
    { id: "e2", source: "feat-auth", target: "mod-routes", type: "owns" },
    { id: "e3", source: "mod-routes", target: "pkg-express", type: "uses" },
    { id: "e4", source: "svc-auth", target: "model-user", type: "reads_from_db" },
    { id: "e5", source: "mod-routes", target: "svc-auth", type: "depends_on" },
    { id: "e6", source: "route-login", target: "svc-auth", type: "calls" },
    { id: "e7", source: "project-root", target: "col-users", type: "owns" }
  ]
};

describe("buildDesignMapFromScanGraph", () => {
  const built = buildDesignMapFromScanGraph(project, graph);
  const byId = new Map(built.nodes.map((n) => [n.id, n]));

  it("creates the design root + design_section anchor", () => {
    const root = byId.get("project");
    expect(root).toBeTruthy();
    expect(root!.type).toBe("project");
    expect((root!.data as any).projectId).toBe("proj-1");
    expect(byId.get("design_section")?.type).toBe("design_section");
    expect(built.edges.some((e) => e.source === "project" && e.target === "design_section" && e.type === "contains")).toBe(true);
  });

  it("folds the intel project node into the root (no duplicate, edges reattach)", () => {
    // No `intel-project-root` node is created.
    expect(byId.has("intel-project-root")).toBe(false);
    // project-root's `owns` edge now points from the design root.
    expect(built.edges.some((e) => e.source === "project" && e.target === "intel-feat-auth" && e.type === "contains")).toBe(true);
    expect(built.edges.some((e) => e.source === "project" && e.target === "intel-col-users" && e.type === "contains")).toBe(true);
  });

  it("maps intel node types to design node types", () => {
    expect(byId.get("intel-feat-auth")?.type).toBe("feature");
    expect(byId.get("intel-mod-routes")?.type).toBe("module");
    expect(byId.get("intel-route-login")?.type).toBe("api_route");
    expect(byId.get("intel-model-user")?.type).toBe("database");
    expect(byId.get("intel-col-users")?.type).toBe("database");
    expect(byId.get("intel-svc-auth")?.type).toBe("module"); // service -> module
    expect(byId.get("intel-cmp-button")?.type).toBe("component");
    expect(byId.get("intel-file-x")?.type).toBe("note"); // everything else -> note
    expect(byId.get("intel-pkg-express")?.type).toBe("note");
  });

  it("carries over label + description and maps confidence", () => {
    const feat = byId.get("intel-feat-auth")!;
    expect(feat.label).toBe("Auth");
    expect(feat.description).toBe("Authentication");
    expect(feat.confidence).toBe("high");
    // A node without a confidence degrades to "low".
    expect(byId.get("intel-route-login")?.confidence).toBe("low");
  });

  it("maps intel edge types to design edge types", () => {
    const edge = (s: string, t: string) => built.edges.find((e) => e.source === s && e.target === t);
    expect(edge("intel-mod-routes", "intel-pkg-express")?.type).toBe("uses");
    expect(edge("intel-svc-auth", "intel-model-user")?.type).toBe("uses"); // reads_from_db -> uses
    expect(edge("intel-mod-routes", "intel-svc-auth")?.type).toBe("depends_on");
    expect(edge("intel-route-login", "intel-svc-auth")?.type).toBe("uses"); // calls -> uses
  });

  it("has no dangling edges (every endpoint resolves to a node)", () => {
    const ids = new Set(built.nodes.map((n) => n.id));
    for (const e of built.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("surfaces the project's own skillIds as skill nodes off the anchor", () => {
    expect(byId.get("skill-s1")?.type).toBe("skill");
    expect(byId.get("skill-s2")?.type).toBe("skill");
    expect(built.edges.some((e) => e.source === "design_section" && e.target === "skill-s1" && e.type === "uses")).toBe(true);
  });

  it("lays nodes out on a deterministic, non-overlapping grid", () => {
    const seen = new Set<string>();
    for (const n of built.nodes) {
      const key = `${n.position.x},${n.position.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Determinism: building again yields identical ids + positions.
    const again = buildDesignMapFromScanGraph(project, graph);
    expect(again.nodes.map((n) => `${n.id}@${n.position.x},${n.position.y}`)).toEqual(
      built.nodes.map((n) => `${n.id}@${n.position.x},${n.position.y}`)
    );
  });

  it("caps a huge graph and drops edges to dropped nodes", () => {
    const many: ScanGraphInput = {
      nodes: [
        { id: "project-root", type: "project", label: "Big" },
        ...Array.from({ length: 600 }, (_, i) => ({
          id: `file-${i}`,
          type: "file",
          label: `f${i}.ts`
        }))
      ],
      edges: Array.from({ length: 600 }, (_, i) => ({
        id: `e-${i}`,
        source: "project-root",
        target: `file-${i}`,
        type: "owns"
      }))
    };
    const big = buildDesignMapFromScanGraph(project, many);
    // project + design_section + 400 intel cap + 2 skills.
    expect(big.nodes.length).toBeLessThanOrEqual(2 + 400 + 2);
    const ids = new Set(big.nodes.map((n) => n.id));
    for (const e of big.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe("buildInitialDesignMap (thin fallback when there is no scan graph)", () => {
  it("seeds from project fields only", () => {
    const { nodes } = buildInitialDesignMap(project);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("project");
    expect(ids).toContain("design_section");
    expect(ids).toContain("feature-desc");
    expect(ids).toContain("skill-s1");
    // The fallback never emits intel-derived nodes.
    expect(ids.some((id) => id.startsWith("intel-"))).toBe(false);
  });
});
