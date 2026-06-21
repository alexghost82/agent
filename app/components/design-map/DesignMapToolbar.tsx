"use client";

import { DESIGN_MAP_NODE_TYPES } from "./types";
import type { DesignMapNodeType } from "./types";

export interface DesignMapToolbarProps {
  onAddNode: (type: DesignMapNodeType) => void;
  onAddSkill: () => void;
  onAddPodskill: () => void;
  onSave: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  activeTypeFilters: DesignMapNodeType[];
  onToggleTypeFilter: (type: DesignMapNodeType) => void;
  dirty: boolean;
  saving: boolean;
  t?: any;
}

export function DesignMapToolbar({
  onAddNode,
  onAddSkill,
  onAddPodskill,
  onSave,
  search,
  onSearchChange,
  activeTypeFilters,
  onToggleTypeFilter,
  dirty,
  saving,
  t
}: DesignMapToolbarProps) {
  const quickAdds: { type: DesignMapNodeType; label: string }[] = [
    { type: "note", label: t?.addNote || "Add note" },
    { type: "feature", label: t?.addFeature || "Add feature" },
    { type: "screen", label: t?.addScreen || "Add screen" },
    { type: "flow", label: t?.addFlow || "Add flow" },
    { type: "risk", label: t?.addRisk || "Add risk" }
  ];

  return (
    <div className="design-map-toolbar">
      <div className="dm-toolbar-group dm-toolbar-adds">
        {quickAdds.map((q) => (
          <button
            key={q.type}
            className="ghost sm"
            type="button"
            onClick={() => onAddNode(q.type)}
          >
            {q.label}
          </button>
        ))}
        <button className="ghost sm" type="button" onClick={onAddSkill}>
          {t?.addSkillToMap || "Add skill"}
        </button>
        <button className="ghost sm" type="button" onClick={onAddPodskill}>
          {t?.addPodskillToMap || "Add podskill"}
        </button>
      </div>

      <div className="dm-toolbar-group dm-toolbar-search">
        <input
          type="search"
          className="dm-search-input"
          value={search}
          placeholder={t?.searchMap || "Search map\u2026"}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      <div
        className="dm-toolbar-group dm-toolbar-filters"
        aria-label={t?.filterNodeTypes || "Filter node types"}
        title={t?.filterNodeTypes || "Filter node types"}
      >
        {DESIGN_MAP_NODE_TYPES.map((type) => {
          const active = activeTypeFilters.includes(type);
          return (
            <button
              key={type}
              type="button"
              className={"dm-chip dm-chip-" + type + (active ? " dm-chip-active" : "")}
              aria-pressed={active}
              onClick={() => onToggleTypeFilter(type)}
            >
              {type}
            </button>
          );
        })}
      </div>

      <div className="dm-toolbar-group dm-toolbar-save">
        <span className={"dm-indicator " + (dirty ? "dm-dirty" : "dm-saved")}>
          {dirty ? t?.mapDirty || "Unsaved changes" : t?.mapSaved || "Saved"}
        </span>
        <button
          className="primary"
          type="button"
          onClick={onSave}
          disabled={saving}
        >
          {saving
            ? `${t?.saveDesignMap || "Save map"}\u2026`
            : t?.saveDesignMap || "Save map"}
        </button>
      </div>
    </div>
  );
}

export default DesignMapToolbar;
