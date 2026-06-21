// Design Map domain types. These mirror the global type contract shared with
// the route layer and the frontend editor. Keep them in sync with the zod
// schemas in `validators.ts`.

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
  // Firestore server timestamps (FieldValue on write, Timestamp on read).
  createdAt?: unknown;
  updatedAt?: unknown;
}

// Partial update payload: only the provided arrays are replaced.
export interface DesignMapPatch {
  nodes?: DesignMapNode[];
  edges?: DesignMapEdge[];
}
