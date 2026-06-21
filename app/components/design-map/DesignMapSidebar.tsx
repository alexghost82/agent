"use client";

import type { DesignMapNode } from "./types";

export interface DesignMapSidebarProps {
  node: DesignMapNode | null;
  onChange: (patch: Partial<DesignMapNode>) => void;
  onClose: () => void;
  t?: any;
}

export function DesignMapSidebar({ node, onChange, onClose, t }: DesignMapSidebarProps) {
  if (!node) {
    return (
      <div className="design-map-sidebar design-map-sidebar-empty">
        <p className="dm-sidebar-hint">{t?.canvasHint || "Select a node\u2026"}</p>
      </div>
    );
  }

  const details = node.data ?? {};

  return (
    <div className="design-map-sidebar">
      <div className="dm-sidebar-header">
        <strong>{t?.nodeDetails || "Node details"}</strong>
        <button className="ghost sm" type="button" onClick={onClose}>
          {t?.close || "Close"}
        </button>
      </div>

      <label className="dm-field">
        <span className="dm-field-label">{t?.nodeLabel || "Label"}</span>
        <input
          type="text"
          className="dm-field-input"
          value={node.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </label>

      <label className="dm-field">
        <span className="dm-field-label">{t?.nodeDescription || "Description"}</span>
        <textarea
          className="dm-field-textarea"
          rows={4}
          value={node.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </label>

      <div className="dm-field dm-field-readonly">
        <span className="dm-field-label">{t?.nodeType || "Type"}</span>
        <span className="dm-field-value">{node.type}</span>
      </div>

      {node.skillId ? (
        <div className="dm-field dm-field-readonly">
          <span className="dm-field-label">{t?.linkedSkill || "Linked skill"}</span>
          <span className="dm-field-value">{node.skillId}</span>
        </div>
      ) : null}

      {node.podskillId ? (
        <div className="dm-field dm-field-readonly">
          <span className="dm-field-label">{t?.linkedPodskill || "Linked podskill"}</span>
          <span className="dm-field-value">{node.podskillId}</span>
        </div>
      ) : null}

      <div className="dm-field dm-field-readonly">
        <span className="dm-field-label">{t?.nodeDetails || "Node details"}</span>
        <pre className="dm-json-preview">{JSON.stringify(details, null, 2)}</pre>
      </div>
    </div>
  );
}

export default DesignMapSidebar;
