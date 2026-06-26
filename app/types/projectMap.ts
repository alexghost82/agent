// Project Intelligence Map — front-end transport contract.
//
// These types describe the payload served by `GET /projects/:id/scan/map`
// (assembled server-side in functions/src/project-intelligence). They are kept
// intentionally tolerant: the live scan payload uses `label`/`type`/`layers`
// while the documented contract prefers `title`/`kind`/`layer`, so both naming
// styles are accepted. Every enrichment field (summary, risks, dependencies,
// fileIndex, groups, details) is OPTIONAL so an older scan that predates the
// enrichment still renders without crashing.

export type ProjectMapLayerId =
  | "overview"
  | "architecture"
  | "code"
  | "feature"
  | "dataFlow"
  | "uiFlow"
  | "risk";

export type ProjectMapNodeKind =
  | "project"
  | "feature"
  | "module"
  | "file"
  | "component"
  | "apiRoute"
  | "dbModel"
  | "service"
  | "externalPackage"
  | "config"
  | "worker"
  | "test"
  | "documentation"
  | "firebaseFunction"
  | "firestoreCollection";

export type ProjectMapSeverity = "info" | "warning" | "critical";

// Rich, lazily-loaded per-node detail surfaced by the "Read more" view.
export interface NodeDetails {
  purpose?: string;
  // Human "how / when this is used" (использование).
  usage?: string;
  stack?: string[];
  inputs?: string[];
  outputs?: string[];
  logic?: string;
  risks?: string[];
  files?: string[];
}

export interface ProjectMapNode {
  id: string;
  // Display name. `title` is the contract field; `label` is the legacy/live
  // scan field. Consumers should read `title ?? label`.
  title?: string;
  label?: string;
  // Node classification. `kind` is the contract field; `type` is legacy/live.
  kind?: ProjectMapNodeKind | string;
  type?: ProjectMapNodeKind | string;
  // Technical file reference shown subtly under the (humanized) title.
  subtitle?: string;
  // Human "how / when this is used" (использование).
  usage?: string;
  // A node can belong to several layers (live) or a single layer (contract).
  layer?: ProjectMapLayerId;
  layers?: ProjectMapLayerId[];
  description?: string;
  tags?: string[];
  files?: string[];
  group?: string | null;
  confidence?: string;
  hasRisk?: boolean;
  position?: { x: number; y: number };
  details?: NodeDetails;
  metadata?: Record<string, unknown>;
}

export interface ProjectMapEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  layers?: ProjectMapLayerId[];
}

export interface ProjectMapGroup {
  id: string;
  label: string;
  layer?: ProjectMapLayerId;
  nodeIds?: string[];
}

export interface ProjectFileIndexItem {
  path: string;
  size?: number;
  language?: string | null;
  role?: string;
}

export interface ProjectTechnology {
  id: string;
  name: string;
  category: string;
  confidence?: string;
  version?: string;
  evidence?: string;
}

export interface ProjectFeature {
  id: string;
  key?: string;
  label: string;
  description?: string | null;
  confidence?: string;
  files?: string[];
  fileCount?: number;
}

export interface ProjectDependency {
  name: string;
  category?: string;
  version?: string;
  confidence?: string;
  usedBy?: number;
}

export interface ProjectInsight {
  id: string;
  kind: string;
  severity: ProjectMapSeverity | string;
  title: string;
  detail: string;
  confidence?: string;
  nodeIds?: string[];
  files?: string[];
}

export interface ProjectRisk {
  id?: string;
  title: string;
  severity: ProjectMapSeverity | string;
  detail?: string;
  files?: string[];
  nodeIds?: string[];
}

export interface ProjectMapStats {
  files: number;
  nodes: number;
  edges: number;
  risks?: number;
  technologies?: number;
}

export interface ProjectMapPayload {
  scanId?: string;
  status?: string;
  generatedAt?: number;
  summary?: string | null;
  nodes: ProjectMapNode[];
  edges: ProjectMapEdge[];
  groups?: ProjectMapGroup[];
  technologies?: ProjectTechnology[];
  features?: ProjectFeature[];
  dependencies?: ProjectDependency[];
  risks?: ProjectRisk[];
  insights?: ProjectInsight[];
  fileIndex?: ProjectFileIndexItem[];
  stats: ProjectMapStats;
}

/* ----------------------------- access helpers ---------------------------- */
// Small, null-safe readers so the UI never throws on a partial/legacy node.

export function nodeTitle(n: ProjectMapNode): string {
  return n.title || n.label || n.id;
}

export function nodeKind(n: ProjectMapNode): string {
  return (n.kind || n.type || "file") as string;
}

export function nodeLayers(n: ProjectMapNode): ProjectMapLayerId[] {
  if (Array.isArray(n.layers) && n.layers.length) return n.layers;
  if (n.layer) return [n.layer];
  return [];
}
