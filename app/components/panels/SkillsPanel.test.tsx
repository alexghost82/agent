import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SkillsPanel } from "./SkillsPanel";
import { DICT } from "../../i18n";
import type { GhostData } from "../../useGhostData";

afterEach(cleanup);

// Minimal GhostData stub covering only what SkillsPanel reads/renders.
// Handlers are no-op stubs; the render test never fires them.
function makeG(overrides: Partial<GhostData> = {}): GhostData {
  const noop = () => {};
  const asyncNoop = async () => ({});
  return {
    t: DICT.en,
    topics: [],
    skills: [],
    stats: null,
    selectedTopic: "",
    setSelectedTopic: noop,
    loading: {},
    output: {},
    loadSkills: noop,
    extractSkills: asyncNoop,
    updateSkill: asyncNoop,
    deleteSkill: asyncNoop,
    ...overrides
  } as unknown as GhostData;
}

describe("SkillsPanel", () => {
  it("renders the panel heading and explainer from the EN dictionary", () => {
    render(<SkillsPanel g={makeG()} />);
    expect(screen.getByText(DICT.en.skillsExplain)).toBeInTheDocument();
    expect(screen.getByText(/Agent skills/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no skills", () => {
    render(<SkillsPanel g={makeG()} />);
    expect(screen.getByText(DICT.en.noSkills)).toBeInTheDocument();
  });

  it("renders the export affordance and disables it without skills", () => {
    render(<SkillsPanel g={makeG()} />);
    const exportBtn = screen.getByRole("button", { name: new RegExp(DICT.en.exportSkills) });
    expect(exportBtn).toBeDisabled();
  });

  it("enables export and lists skills once data is present", () => {
    render(
      <SkillsPanel
        g={makeG({
          skills: [{ id: "s1", skillName: "Caching", description: "Use a cache", source: "learned" }]
        })}
      />
    );
    expect(screen.getByText("Caching")).toBeInTheDocument();
    const exportBtn = screen.getByRole("button", { name: new RegExp(DICT.en.exportSkills) });
    expect(exportBtn).not.toBeDisabled();
  });
});
