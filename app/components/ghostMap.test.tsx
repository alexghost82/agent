import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { normalizeToGhostMap } from "./ghostMapAdapter";
import { GhostMap } from "./GhostMap";
import { PROJECT_MAP_DEMO } from "./projectMapDemoPayload";
import type { ProjectMapData } from "./ProjectMap";
import { DICT } from "../i18n";

beforeAll(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(cleanup);

describe("normalizeToGhostMap", () => {
  it("maps scan node types to reference colour categories", () => {
    const { nodes } = normalizeToGhostMap(PROJECT_MAP_DEMO);
    const layerOf = (id: string) => nodes.find((n) => n.id === id)?.layer;
    expect(layerOf("frontend-dashboard")).toBe("frontend"); // component
    expect(layerOf("api-projects")).toBe("backend"); // apiRoute
    expect(layerOf("data-firestore")).toBe("data"); // firestoreCollection
    // authService.ts is a service but keyword refinement promotes it to admin.
    expect(layerOf("auth-service")).toBe("admin");
  });

  it("skips edges whose endpoints are missing instead of crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data: ProjectMapData = {
      nodes: [
        { id: "a", type: "component", label: "A", confidence: "high", layers: ["overview"], position: { x: 0, y: 0 } }
      ],
      edges: [
        { id: "e1", source: "a", target: "ghost", type: "calls", label: "calls", layers: ["overview"] }
      ],
      technologies: [],
      features: [],
      insights: [],
      stats: { files: 0, nodes: 1, edges: 1 }
    };
    const { edges } = normalizeToGhostMap(data);
    expect(edges).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("synthesizes risk nodes (and risk edges) from scan risks", () => {
    const { nodes, edges } = normalizeToGhostMap(PROJECT_MAP_DEMO);
    const riskNode = nodes.find((n) => n.layer === "risk");
    expect(riskNode).toBeTruthy();
    expect(edges.some((e) => e.type === "risk" && e.to === riskNode!.id)).toBe(true);
  });

  it("tolerates an empty / null payload", () => {
    expect(() => normalizeToGhostMap(null)).not.toThrow();
    const { nodes, edges } = normalizeToGhostMap(undefined);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

describe("GhostMap render", () => {
  it("renders the toolbar, layer chips and node cards", () => {
    render(<GhostMap data={PROJECT_MAP_DEMO} projectId="p1" projectName="Demo App" t={DICT.en} />);
    expect(screen.getByRole("button", { name: /Fit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reset layout/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    // A node card title from the demo payload.
    expect(screen.getByText("Dashboard.tsx")).toBeInTheDocument();
  });

  it("opens the Read more modal for a node", () => {
    render(<GhostMap data={PROJECT_MAP_DEMO} projectId="p1" projectName="Demo App" t={DICT.en} />);
    const readButtons = screen.getAllByRole("button", { name: /Read more/i });
    fireEvent.click(readButtons[0]);
    expect(screen.getByText(DICT.en.intelPurpose || "Purpose")).toBeInTheDocument();
  });
});
