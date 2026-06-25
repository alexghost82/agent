import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SkillsPanel } from "./SkillsPanel";
import { DICT } from "../../i18n";
import type { GhostData } from "../../useGhostData";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Minimal GhostData stub covering only what SkillsPanel reads/renders. The
// action handlers default to spies so interaction tests can assert the panel
// wires its buttons to the real GhostData commands (edit -> updateSkill,
// delete -> deleteSkill), instead of silently no-op'ing them.
function makeG(overrides: Partial<GhostData> = {}): GhostData {
  const noop = () => {};
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
    extractSkills: vi.fn(async () => ({})),
    updateSkill: vi.fn(async () => ({})),
    deleteSkill: vi.fn(async () => ({})),
    ...overrides
  } as unknown as GhostData;
}

// Render a single skill and open the category modal that exposes its edit/delete
// affordances (skills are grouped into clickable tiles).
function openSkillModal(g: GhostData) {
  render(<SkillsPanel g={g} />);
  fireEvent.click(screen.getByRole("button", { name: /\(1\)/ }));
}

describe("SkillsPanel", () => {
  it("renders the panel heading and explainer from the EN dictionary", () => {
    render(<SkillsPanel g={makeG()} />);
    expect(screen.getByText(DICT.en.skillsExplain)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Agent skills/ })).toBeInTheDocument();
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

  it("enables export and lists skills (via category tile + modal) once data is present", () => {
    render(
      <SkillsPanel
        g={makeG({
          skills: [{ id: "s1", skillName: "Caching", description: "Use a cache", source: "learned" }]
        })}
      />
    );
    // Skills are now grouped into clickable category tiles; the tile shows a
    // count, and the individual skill names render inside the modal it opens.
    const tile = screen.getByRole("button", { name: /\(1\)/ });
    expect(tile).toBeInTheDocument();
    fireEvent.click(tile);
    expect(screen.getByText("Caching")).toBeInTheDocument();
    const exportBtn = screen.getByRole("button", { name: new RegExp(DICT.en.exportSkills) });
    expect(exportBtn).not.toBeDisabled();
  });

  it("fires deleteSkill with the skill id when the delete button is confirmed", () => {
    vi.stubGlobal("confirm", () => true);
    const deleteSkill = vi.fn(async () => ({}));
    openSkillModal(
      makeG({
        skills: [{ id: "s1", skillName: "Caching", description: "Use a cache", source: "learned" }],
        deleteSkill
      })
    );
    fireEvent.click(screen.getByRole("button", { name: DICT.en.delete }));
    expect(deleteSkill).toHaveBeenCalledWith("s1");
  });

  it("does not delete when the confirm dialog is dismissed", () => {
    vi.stubGlobal("confirm", () => false);
    const deleteSkill = vi.fn(async () => ({}));
    openSkillModal(
      makeG({
        skills: [{ id: "s1", skillName: "Caching", description: "Use a cache", source: "learned" }],
        deleteSkill
      })
    );
    fireEvent.click(screen.getByRole("button", { name: DICT.en.delete }));
    expect(deleteSkill).not.toHaveBeenCalled();
  });

  it("fires updateSkill with the edited fields when saving an edit", () => {
    const updateSkill = vi.fn(async () => ({}));
    openSkillModal(
      makeG({
        skills: [{ id: "s1", skillName: "Caching", description: "Use a cache", source: "learned" }],
        updateSkill
      })
    );
    fireEvent.click(screen.getByRole("button", { name: new RegExp(DICT.en.edit) }));
    fireEvent.change(screen.getByDisplayValue("Caching"), { target: { value: "Caching v2" } });
    fireEvent.click(screen.getByRole("button", { name: DICT.en.save }));
    expect(updateSkill).toHaveBeenCalledWith("s1", {
      skillName: "Caching v2",
      description: "Use a cache",
      example: undefined
    });
  });
});
