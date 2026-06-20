// Project Intelligence — shared types.
//
// The whole project-intelligence package (scanner → detectors → analyzers →
// graph → ai → storage) speaks in these types. They are intentionally
// transport-friendly (plain JSON) so they double as the API payload shape
// served to the React Flow client.

export type ScanStatus = "pending" | "scanning" | "analyzing" | "completed" | "failed";

// A node's confidence. `inferred` specifically marks values produced (or only
// guessed) by the AI layer and never confirmed by code — the UI badges these.
export type Confidence = "high" | "medium" | "low" | "inferred";

export type NodeType =
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
  // Firebase-specific synthesized nodes (not derived from a single file role):
  // a deployed Cloud Function (api / ingestWorker / scanWorker) and a Firestore
  // collection referenced from code.
  | "firebaseFunction"
  | "firestoreCollection";

export type EdgeType =
  | "imports"
  | "calls"
  | "uses"
  | "owns"
  | "exposes"
  | "reads_from_db"
  | "writes_to_db"
  | "renders"
  | "depends_on"
  | "configured_by"
  | "tested_by";

// Display layers (the "levels" the user can switch between). A node/edge can
// belong to several layers; the client filters by the active layer.
export type LayerId =
  | "overview"
  | "architecture"
  | "code"
  | "feature"
  | "dataFlow"
  | "uiFlow"
  | "risk";

export const LAYER_IDS: LayerId[] = [
  "overview",
  "architecture",
  "code",
  "feature",
  "dataFlow",
  "uiFlow",
  "risk"
];

// Coarse classification of a file by its path/name, used by detectors and the
// graph builder to decide node types and which layers a file belongs to.
export type FileRole =
  | "config"
  | "route"
  | "component"
  | "service"
  | "hook"
  | "store"
  | "worker"
  | "test"
  | "doc"
  | "schema"
  | "migration"
  | "style"
  | "source"
  | "other";

export interface FileIndexEntry {
  path: string;
  size: number;
  language: string | null;
  role: FileRole;
}

export type TechCategory =
  | "language"
  | "frontend"
  | "backend"
  | "database"
  | "orm"
  | "auth"
  | "state"
  | "uiKit"
  | "testing"
  | "build"
  | "deploy"
  | "queue"
  | "cache"
  | "search"
  | "runtime"
  | "other";

export interface Technology {
  id: string;
  name: string;
  category: TechCategory;
  confidence: Confidence;
  // Where it was detected (file path / dependency name), for the sidebar.
  evidence?: string;
  version?: string;
}

export interface Feature {
  id: string;
  // Canonical key (e.g. "auth", "billing") so detection is stable across scans.
  key: string;
  label: string;
  description?: string;
  confidence: Confidence;
  files: string[];
}

export type InsightKind =
  | "cycle"
  | "large_file"
  | "god_file"
  | "orphan"
  | "missing_tests"
  | "secret_risk"
  | "note";

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  nodeIds?: string[];
  files?: string[];
  confidence: Confidence;
}

export interface IntelNode {
  id: string;
  type: NodeType;
  label: string;
  // Grouping handle (feature id or directory) for collapsible groups.
  group?: string;
  description?: string;
  confidence: Confidence;
  layers: LayerId[];
  files: string[];
  position: { x: number; y: number };
  metadata: Record<string, unknown>;
}

export interface IntelEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label: string;
  layers: LayerId[];
}

// The graph payload served to the client (light per-node data; full per-node
// detail is fetched lazily via GET /projects/:id/nodes/:nodeId).
export interface MapPayload {
  scanId: string;
  status: ScanStatus;
  generatedAt?: number;
  nodes: IntelNode[];
  edges: IntelEdge[];
  technologies: Technology[];
  features: Feature[];
  insights: Insight[];
  stats: { files: number; nodes: number; edges: number };
}

/* -------------------------------------------------------------------------- */
/* Scanner output                                                             */
/* -------------------------------------------------------------------------- */

export interface ScannedFile {
  path: string;
  size: number;
  language: string | null;
  role: FileRole;
  // Present only for the bounded set of files whose raw content was fetched.
  // SECURITY: never populated for secret files (.env and friends).
  content?: string;
}

export interface ScanResult {
  branch: string;
  files: ScannedFile[];
  // True when file/content caps were hit (the graph is a partial view).
  truncated: boolean;
  totalTreeFiles: number;
}

/* -------------------------------------------------------------------------- */
/* Language adapter (dependency analysis)                                     */
/* -------------------------------------------------------------------------- */

export interface ImportRef {
  // The raw import specifier as written in the source.
  raw: string;
  // Resolved internal file path (when the specifier points inside the repo).
  resolvedPath?: string;
  // External package name (when the specifier is a third-party dependency).
  external?: string;
}

export interface AnalyzedModule {
  path: string;
  imports: ImportRef[];
  exports: string[];
}

// Pluggable per-language dependency extractor. JS/TS ships first; Python/Go/Java
// can be added later by implementing this same interface (no graph changes).
export interface LanguageAdapter {
  id: string;
  matches(file: ScannedFile): boolean;
  analyze(file: ScannedFile, internalPaths: Set<string>): AnalyzedModule;
}

/* -------------------------------------------------------------------------- */
/* Orchestrator payload                                                       */
/* -------------------------------------------------------------------------- */

export interface ScanOptions {
  // Cap on graph depth from the project root (lazy-loadable beyond this).
  maxDepth?: number;
  // Enable the AI summary layer (no-ops gracefully without an API key).
  ai?: boolean;
}
