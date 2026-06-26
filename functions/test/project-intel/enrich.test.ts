/**
 * Unit tests — project-intelligence AI enrichment (project-intelligence/ai/summarize).
 *
 * Runs WITHOUT the emulator by mocking `../src/ai`'s `llm`. Verifies the
 * structure→explanation mapping (summary→root node, purpose→feature, userFlows/
 * risks→insights) and the two NEVER-throw fallbacks (unparseable model output
 * and a provider error) that keep the scan pipeline resilient.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntelNode, Technology, Feature, Insight } from "../../src/project-intelligence/types";

const ai = vi.hoisted(() => ({ llm: vi.fn(async (..._a: any[]) => "") }));
vi.mock("../../src/ai", () => ({ llm: ai.llm }));

import { enrichWithAI, type EnrichInput } from "../../src/project-intelligence/ai/summarize";

function baseInput(): EnrichInput {
  const nodes: IntelNode[] = [
    {
      id: "n-project",
      type: "project",
      label: "Demo",
      confidence: "high",
      layers: ["overview"],
      files: [],
      position: { x: 0, y: 0 },
      metadata: {}
    },
    {
      id: "n-auth",
      type: "feature",
      label: "Auth",
      confidence: "medium",
      layers: ["feature"],
      files: ["src/auth.ts"],
      position: { x: 0, y: 0 },
      metadata: { key: "auth" }
    },
    {
      id: "n-route",
      type: "apiRoute",
      label: "/login",
      confidence: "high",
      layers: ["architecture"],
      files: [],
      position: { x: 0, y: 0 },
      metadata: {}
    }
  ];
  const technologies: Technology[] = [
    { id: "t-next", name: "Next.js", category: "frontend", confidence: "high" }
  ];
  const features: Feature[] = [
    { id: "f-auth", key: "auth", label: "Auth", confidence: "medium", files: ["src/auth.ts"] }
  ];
  const insights: Insight[] = [];
  return { projectName: "Demo", nodes, technologies, features, insights, userId: "u1" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enrichWithAI (project-intelligence)", () => {
  it("maps the project-level pass onto root/feature/insights", async () => {
    // First call = project-level object; later calls = node batches (arrays).
    ai.llm
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: "A demo app for X.",
          features: [{ key: "auth", purpose: "Signs users in." }],
          userFlows: ["User logs in", "User signs out"],
          risks: ["No rate limiting on login"]
        })
      )
      .mockResolvedValue("[]");

    const input = baseInput();
    const res = await enrichWithAI(input);

    expect(res.aiUsed).toBe(true);

    // Project summary lands on the root node (marked inferred, non-mutating to input).
    const root = res.nodes.find((n) => n.type === "project")!;
    expect(root.description).toBe("A demo app for X.");
    expect(root.confidence).toBe("inferred");
    expect((root.metadata as any).aiSummary).toBe(true);
    expect(input.nodes.find((n) => n.type === "project")!.description).toBeUndefined();

    // Per-feature purpose lands on the feature record.
    expect(res.features.find((f) => f.key === "auth")!.description).toBe("Signs users in.");

    // userFlows (2) + risks (1) become inferred "note" insights.
    const notes = res.insights.filter((i) => i.kind === "note" && i.confidence === "inferred");
    expect(notes).toHaveLength(3);
    expect(notes.some((n) => n.detail === "User logs in")).toBe(true);
    expect(notes.some((n) => n.detail === "No rate limiting on login")).toBe(true);
  });

  it("humanizes meaningful nodes with name / purpose / usage from the node pass", async () => {
    ai.llm
      .mockResolvedValueOnce("{}") // project-level pass (no-op)
      .mockResolvedValue(
        JSON.stringify([
          { id: "n-route", name: "Login endpoint", purpose: "Authenticates a user", usage: "Called when a user submits the login form" }
        ])
      );

    const input = baseInput();
    const res = await enrichWithAI(input);

    expect(res.aiUsed).toBe(true);
    const route = res.nodes.find((n) => n.id === "n-route")!;
    expect(route.label).toBe("Login endpoint");
    expect(route.description).toBe("Authenticates a user");
    expect(route.usage).toBe("Called when a user submits the login form");
    expect(route.confidence).toBe("inferred");
    // The original technical label is preserved as metadata.path.
    expect((route.metadata as any).path).toBe("/login");

    // Input is never mutated (a working copy is returned).
    expect(input.nodes.find((n) => n.id === "n-route")!.label).toBe("/login");
  });

  it("returns the inputs (by value) unchanged when the model output is not parseable", async () => {
    ai.llm.mockResolvedValue("not json at all");
    const input = baseInput();
    const res = await enrichWithAI(input);

    expect(res.aiUsed).toBe(false);
    // Content is unchanged even though a fresh copy is returned.
    expect(res.nodes).toEqual(input.nodes);
    expect(res.nodes.find((n) => n.type === "project")!.description).toBeUndefined();
  });

  it("never throws when the provider errors (returns fallback, aiUsed=false)", async () => {
    ai.llm.mockRejectedValue(new Error("no_api_key"));
    const input = baseInput();
    const res = await enrichWithAI(input);

    expect(res.aiUsed).toBe(false);
    expect(res.nodes).toEqual(input.nodes);
  });
});
