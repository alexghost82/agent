"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { DesignMapNodeType, DesignMapConfidence } from "./types";

// Short text/icon shown in the type badge for each node type.
const NODE_TYPE_BADGE: Record<DesignMapNodeType, string> = {
  project: "PRJ",
  design_section: "SEC",
  feature: "FEA",
  module: "MOD",
  screen: "SCR",
  component: "CMP",
  api_route: "API",
  database: "DB",
  flow: "FLW",
  skill: "SKL",
  podskill: "PSK",
  decision: "DEC",
  risk: "RSK",
  note: "NOT"
};

function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + "\u2026";
}

export interface DesignMapNodeData extends Record<string, unknown> {
  type: DesignMapNodeType;
  label: string;
  description?: string;
  skillId?: string;
  podskillId?: string;
  confidence?: DesignMapConfidence;
}

function DesignMapNodeComponent({ data, selected }: NodeProps) {
  const d = (data ?? {}) as DesignMapNodeData;
  const type = d.type ?? "note";
  const label = d.label ?? "";
  const description = typeof d.description === "string" ? d.description : "";
  const badge = NODE_TYPE_BADGE[type] ?? "NOT";

  return (
    <div
      className={
        "design-map-node dm-node-" + type + (selected ? " dm-node-selected" : "")
      }
    >
      <Handle type="target" position={Position.Left} />
      <div className="dm-node-head">
        <span className={"dm-badge dm-badge-" + type} title={type}>
          {badge}
        </span>
        <strong className="dm-node-label">{label}</strong>
      </div>
      {description ? (
        <div className="dm-node-desc">{truncate(description)}</div>
      ) : null}
      {d.confidence ? (
        <span className={"dm-confidence dm-confidence-" + d.confidence}>
          {d.confidence}
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const DesignMapNode = memo(DesignMapNodeComponent);

export default DesignMapNode;
