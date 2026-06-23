/**
 * Unit tests — buildInitialDesignMap skill seeding.
 *
 * Pure (no emulator): verifies that enriched skills produce nodes carrying the
 * real skill name + description, that the raw-id fallback still works for
 * back-compat, and that the deterministic grid layout is preserved.
 */
import { describe, it, expect } from "vitest";
import { buildInitialDesignMap } from "../src/designMap/initialMap";

describe("buildInitialDesignMap — skill nodes", () => {
  it("uses the real skillName as label and description from enriched skills", () => {
    const { nodes } = buildInitialDesignMap({
      id: "proj1",
      name: "Demo",
      skills: [{ id: "s1", skillName: "Authentication", description: "How auth works" }]
    });

    const skill = nodes.find((n) => n.id === "skill-s1");
    expect(skill).toBeTruthy();
    expect(skill?.type).toBe("skill");
    expect(skill?.label).toBe("Authentication");
    expect(skill?.description).toBe("How auth works");
    expect(skill?.skillId).toBe("s1");
    expect(skill?.confidence).toBe("manual");
  });

  it("omits description when the enriched skill has none", () => {
    const { nodes } = buildInitialDesignMap({
      id: "proj1",
      skills: [{ id: "s1", skillName: "Caching" }]
    });
    const skill = nodes.find((n) => n.id === "skill-s1");
    expect(skill?.label).toBe("Caching");
    expect(skill?.description).toBeUndefined();
  });

  it("truncates long names (200) and descriptions (5000)", () => {
    const longName = "N".repeat(500);
    const longDesc = "D".repeat(6000);
    const { nodes } = buildInitialDesignMap({
      id: "proj1",
      skills: [{ id: "s1", skillName: longName, description: longDesc }]
    });
    const skill = nodes.find((n) => n.id === "skill-s1");
    expect(skill?.label.length).toBe(200);
    expect(skill?.description?.length).toBe(5000);
  });

  it("lays skill nodes out in a deterministic 8-per-column grid", () => {
    const skills = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, skillName: `Skill ${i}` }));
    const { nodes } = buildInitialDesignMap({ id: "proj1", skills });

    const first = nodes.find((n) => n.id === "skill-s0");
    const ninth = nodes.find((n) => n.id === "skill-s8");
    // Column 0, row 0 vs column 1, row 0 — the 9th wraps to the next column.
    expect(first?.position).toEqual({ x: 320 * 3, y: 0 });
    expect(ninth?.position).toEqual({ x: 320 * 4, y: 0 });
  });

  it("falls back to a generic label for raw skillIds (back-compat)", () => {
    const { nodes } = buildInitialDesignMap({ id: "proj1", skillIds: ["s1"] });
    const skill = nodes.find((n) => n.id === "skill-s1");
    expect(skill?.label).toBe("Skill s1");
    expect(skill?.description).toBeUndefined();
  });

  it("prefers enriched skills over raw skillIds when both are present", () => {
    const { nodes } = buildInitialDesignMap({
      id: "proj1",
      skillIds: ["s1", "s2"],
      skills: [{ id: "s1", skillName: "Only One" }]
    });
    expect(nodes.find((n) => n.id === "skill-s1")?.label).toBe("Only One");
    // s2 came only from skillIds and must not appear once enriched skills win.
    expect(nodes.find((n) => n.id === "skill-s2")).toBeUndefined();
  });
});
