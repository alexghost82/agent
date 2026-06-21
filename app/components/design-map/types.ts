// Shared frontend Design Map types. This is the single source of truth for
// Design Map types on the client — other Design Map components import from here.
// Mirrors the global type contract shared with the backend route layer.
// Keep dependency-free (no React imports).

export type DesignMapNodeType =
  | "project"
  | "design_section"
  | "feature"
  | "module"
  | "screen"
  | "component"
  | "api_route"
  | "database"
  | "flow"
  | "skill"
  | "podskill"
  | "decision"
  | "risk"
  | "note";

export type DesignMapEdgeType =
  | "depends_on"
  | "uses"
  | "contains"
  | "triggers"
  | "produces"
  | "blocks"
  | "implements"
  | "improves"
  | "related_to";

export type DesignMapConfidence = "high" | "medium" | "low" | "manual";

export interface DesignMapNode {
  id: string;
  type: DesignMapNodeType;
  label: string;
  description?: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
  skillId?: string;
  podskillId?: string;
  confidence?: DesignMapConfidence;
}

export interface DesignMapEdge {
  id: string;
  source: string;
  target: string;
  type: DesignMapEdgeType;
  label?: string;
  data?: Record<string, unknown>;
}

export interface DesignMap {
  projectId: string;
  userId: string;
  nodes: DesignMapNode[];
  edges: DesignMapEdge[];
  version: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// All node types, handy for toolbar / filter UIs.
export const DESIGN_MAP_NODE_TYPES: readonly DesignMapNodeType[] = [
  "project",
  "design_section",
  "feature",
  "module",
  "screen",
  "component",
  "api_route",
  "database",
  "flow",
  "skill",
  "podskill",
  "decision",
  "risk",
  "note"
];

// All edge types, handy for toolbar / filter UIs.
export const DESIGN_MAP_EDGE_TYPES: readonly DesignMapEdgeType[] = [
  "depends_on",
  "uses",
  "contains",
  "triggers",
  "produces",
  "blocks",
  "implements",
  "improves",
  "related_to"
];
