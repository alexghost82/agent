import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProjectMap, buildMapJson, buildMapMarkdown, type ProjectMapData } from "./ProjectMap";
import { PROJECT_MAP_DEMO } from "./projectMapDemoPayload";
import { DICT } from "../i18n";

// React Flow relies on ResizeObserver, which jsdom does not implement.
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

// A legacy payload that predates the enrichment fields (no summary/risks/
// dependencies/fileIndex/groups). It must still build + render.
const LEGACY: ProjectMapData = {
  nodes: [
    {
      id: "n1",
      type: "project",
      label: "Legacy Root",
      confidence: "high",
      layers: ["overview"],
      position: { x: 0, y: 0 }
    }
  ],
  edges: [],
  technologies: [],
  features: [],
  insights: [],
  stats: { files: 0, nodes: 1, edges: 0 }
};

describe("buildMapJson", () => {
  it("produces valid JSON with the full payload", () => {
    const parsed = JSON.parse(buildMapJson(PROJECT_MAP_DEMO));
    expect(parsed.nodes.length).toBe(PROJECT_MAP_DEMO.nodes.length);
    expect(parsed.edges.length).toBe(PROJECT_MAP_DEMO.edges.length);
    expect(Array.isArray(parsed.fileIndex)).toBe(true);
    expect(parsed.summary).toContain("Demo workspace");
  });

  it("does not throw and stays valid on a legacy payload with missing fields", () => {
    const json = buildMapJson(LEGACY);
    const parsed = JSON.parse(json);
    expect(parsed.nodes.length).toBe(1);
    expect(parsed.fileIndex).toEqual([]);
    expect(parsed.summary).toBeNull();
  });
});

describe("buildMapMarkdown", () => {
  it("renders human-readable sections from the full payload", () => {
    const md = buildMapMarkdown(PROJECT_MAP_DEMO, "Demo App");
    expect(md).toContain("# Demo App — Project Map");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Technologies");
    expect(md).toContain("## Risks");
    expect(md).toContain("## Nodes");
    expect(md).toContain("## File index");
    // Node detail fields are flattened into the report.
    expect(md).toContain("Purpose:");
  });

  it("still produces a valid report for a legacy payload", () => {
    const md = buildMapMarkdown(LEGACY, "Old");
    expect(md).toContain("# Old — Project Map");
    expect(md).toContain("## Overview");
    // Optional sections are omitted, not crashing.
    expect(md).not.toContain("## Risks");
  });
});

describe("ProjectMap workspace", () => {
  const noop = () => {};

  it("renders the toolbar, search, export actions and summary stats", () => {
    render(<ProjectMap data={PROJECT_MAP_DEMO} t={DICT.en} projectName="Demo App" onSelectNode={noop} selectedNodeId={null} />);
    expect(screen.getByRole("button", { name: /Export JSON/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export Markdown/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    // Stat labels in the right summary panel.
    expect(screen.getByText(/Technologies \(5\)/)).toBeInTheDocument();
  });

  it("triggers a Blob download when Export JSON is clicked", () => {
    const createSpy = vi.fn(() => "blob:mock");
    const revokeSpy = vi.fn();
    (URL as any).createObjectURL = createSpy;
    (URL as any).revokeObjectURL = revokeSpy;
    render(<ProjectMap data={PROJECT_MAP_DEMO} t={DICT.en} projectName="Demo App" onSelectNode={noop} selectedNodeId={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Export JSON/i }));
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("does not crash when searching a payload whose nodes lack optional fields", () => {
    render(<ProjectMap data={LEGACY} t={DICT.en} projectName="Old" onSelectNode={noop} selectedNodeId={null} />);
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: "anything missing fields" } });
    // Toolbar is still present → no render crash.
    expect(screen.getByRole("button", { name: /Export JSON/i })).toBeInTheDocument();
  });

  it("renders a legacy payload (no enrichment) without throwing", () => {
    render(<ProjectMap data={LEGACY} t={DICT.en} projectName="Old" onSelectNode={noop} selectedNodeId={null} />);
    expect(screen.getByRole("button", { name: /Export Markdown/i })).toBeInTheDocument();
  });
});
