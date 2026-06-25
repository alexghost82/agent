// Ghost Map — internal render format.
//
// This is the normalized shape consumed by the custom DOM/SVG renderer
// (GhostMap.tsx). It is produced from the live scan payload (ProjectMapData)
// by ghostMapAdapter.normalizeToGhostMap(). It deliberately mirrors the
// reference "Ghost Project — Interactive Technical & Logic Map" data model so
// the renderer can stay close to the reference behaviour.

// The nine reference colour categories. A node's `layer` is always one of these
// ids; chips/legend/group boxes are keyed by them.
export type GhostLayerId =
  | "frontend"
  | "backend"
  | "ai"
  | "camera"
  | "data"
  | "ops"
  | "ux"
  | "admin"
  | "risk";

export interface MapLayer {
  id: string;
  label: string;
  color: string;
}

export interface MapGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapNodeDetails {
  purpose?: string;
  stack?: string[];
  inputs?: string[];
  outputs?: string[];
  logic?: string[];
  risks?: string[];
  files?: string[];
  raw?: unknown;
}

export interface MapNode {
  id: string;
  title: string;
  kind: string;
  layer: string;
  desc: string;
  tags: string[];
  x: number;
  y: number;
  details: MapNodeDetails;
}

export interface MapEdge {
  from: string;
  to: string;
  type?: "default" | "hot" | "warn" | "risk";
}

export interface GhostMapModel {
  layers: MapLayer[];
  groups: MapGroup[];
  nodes: MapNode[];
  edges: MapEdge[];
}
