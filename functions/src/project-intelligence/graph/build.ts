import type {
  ScannedFile,
  Technology,
  Feature,
  Insight,
  IntelNode,
  IntelEdge,
  NodeType,
  LayerId,
  FileRole
} from "../types";
import type { DependencyGraph } from "../analyzers/dependencies";
import { nodeTypeForRole, layersForNodeType, classifyEdge, TIER_X, ROW_GAP } from "./layers";
import { detectFirebaseFunctions, detectFirestoreCollections } from "../detectors/firebase";

export interface BuildGraphInput {
  projectName: string;
  files: ScannedFile[];
  technologies: Technology[];
  features: Feature[];
  graph: DependencyGraph;
  insights: Insight[];
  maxNodes?: number;
  maxDepth?: number;
}

export interface BuiltGraph {
  nodes: IntelNode[];
  edges: IntelEdge[];
}

const MODULE_DEPTH = 2;
const MAX_EXTERNAL = 30;
const MAX_USES_EDGES_PER_PKG = 5;
const DEFAULT_MAX_NODES = 800;

// Distinct x per type so React Flow renders readable left→right columns.
const COLUMN_X: Record<NodeType, number> = {
  project: 0,
  feature: 340,
  module: 680,
  apiRoute: 1020,
  service: 1020,
  worker: 1020,
  firebaseFunction: 1020,
  dbModel: 1360,
  firestoreCollection: 1360,
  component: 1700,
  file: 1700,
  config: 2040,
  test: 2040,
  documentation: 2040,
  externalPackage: 2380
};

// Roles whose files are kept first when the node budget is tight.
const PRIORITY_ROLES: ReadonlySet<FileRole> = new Set<FileRole>([
  "route",
  "service",
  "component",
  "worker",
  "schema",
  "migration",
  "config",
  "store",
  "hook"
]);

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function moduleKey(path: string): string {
  const dir = path.split("/").slice(0, -1);
  if (dir.length === 0) return "(root)";
  return dir.slice(0, MODULE_DEPTH).join("/");
}

function describeFile(role: FileRole, language: string | null): string {
  const lang = language ? ` Written in ${language}.` : "";
  const label: Record<string, string> = {
    route: "Handles incoming requests for this part of the app and returns responses.",
    service: "Holds business logic that other parts of the app call to get work done.",
    component: "Renders a piece of the user interface on screen.",
    worker: "Runs background work outside the normal request flow.",
    schema: "Defines the shape of data the app stores.",
    migration: "Updates the database structure when the app changes.",
    config: "Configures how the app builds, runs or deploys.",
    hook: "Reusable piece of UI logic shared across the interface.",
    store: "Keeps and shares application state.",
    test: "Checks that the related code behaves correctly.",
    doc: "Explains part of the project for people.",
    style: "Defines the visual styling of the interface.",
    source: "A building block of the project's code.",
    other: "A file in the project."
  };
  return `${label[role] || "A file in the project."}${lang}`;
}

// Assemble the typed, layered node/edge graph from scan + analysis outputs.
// Pure + deterministic so it can be unit-tested without network/Firebase.
export function buildGraph(input: BuildGraphInput): BuiltGraph {
  const maxNodes = input.maxNodes ?? DEFAULT_MAX_NODES;
  const nodes: IntelNode[] = [];
  const edges: IntelEdge[] = [];
  const colY = new Map<number, number>();
  let edgeSeq = 0;
  let fileSeq = 0;
  let moduleSeq = 0;

  const place = (type: NodeType): { x: number; y: number } => {
    const x = COLUMN_X[type];
    const y = colY.get(x) ?? 0;
    colY.set(x, y + ROW_GAP);
    return { x, y };
  };
  const addEdge = (source: string, target: string, type: IntelEdge["type"], layers: LayerId[]) => {
    edges.push({ id: `e-${edgeSeq++}`, source, target, type, label: type.replace(/_/g, " "), layers });
  };

  // ---- Project root ---------------------------------------------------------
  const projectId = "project-root";
  nodes.push({
    id: projectId,
    type: "project",
    label: input.projectName || "Project",
    description: `Root of ${input.projectName || "the project"}.`,
    confidence: "high",
    layers: layersForNodeType("project"),
    files: [],
    position: place("project"),
    metadata: { files: input.files.length }
  });

  // ---- Depth filter + file-node selection ----------------------------------
  let candidateFiles = input.files;
  if (input.maxDepth && input.maxDepth > 0) {
    candidateFiles = candidateFiles.filter((f) => f.path.split("/").length <= input.maxDepth!);
  }
  const fileBudget = Math.max(50, maxNodes - 120);
  const ordered = [
    ...candidateFiles.filter((f) => PRIORITY_ROLES.has(f.role)),
    ...candidateFiles.filter((f) => !PRIORITY_ROLES.has(f.role))
  ];
  const chosen = ordered.slice(0, fileBudget);

  const fileNodeId = new Map<string, string>();
  const roleByPath = new Map<string, FileRole>();
  for (const f of input.files) roleByPath.set(f.path, f.role);

  // ---- Features -------------------------------------------------------------
  const featureByPath = new Map<string, string>();
  for (const feat of input.features) {
    nodes.push({
      id: feat.id,
      type: "feature",
      // No group: a feature's parent is the project root, not itself. (Groups
      // point at the PARENT so the UI can collapse children by group id.)
      label: feat.label,
      description: feat.description,
      confidence: feat.confidence,
      layers: layersForNodeType("feature"),
      files: feat.files.slice(0, 300),
      position: place("feature"),
      metadata: { key: feat.key, fileCount: feat.files.length }
    });
    addEdge(projectId, feat.id, "owns", ["overview", "feature"]);
    for (const p of feat.files) if (!featureByPath.has(p)) featureByPath.set(p, feat.id);
  }

  // ---- Modules (created from chosen files) ----------------------------------
  const moduleId = new Map<string, string>();
  const moduleFiles = new Map<string, string[]>();
  for (const f of chosen) {
    const key = moduleKey(f.path);
    if (!moduleFiles.has(key)) moduleFiles.set(key, []);
    moduleFiles.get(key)!.push(f.path);
  }
  for (const [key, paths] of moduleFiles) {
    const id = `mod-${moduleSeq++}`;
    moduleId.set(key, id);
    // A module inherits the feature of the majority of its files (best-effort).
    const featCounts = new Map<string, number>();
    for (const p of paths) {
      const fid = featureByPath.get(p);
      if (fid) featCounts.set(fid, (featCounts.get(fid) || 0) + 1);
    }
    const owningFeature = [...featCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    nodes.push({
      id,
      type: "module",
      label: key,
      group: owningFeature,
      description: `A group of ${paths.length} related file(s) that work together.`,
      confidence: "high",
      layers: layersForNodeType("module"),
      files: paths.slice(0, 300),
      position: place("module"),
      metadata: { key, fileCount: paths.length }
    });
    if (owningFeature) addEdge(owningFeature, id, "owns", ["feature", "architecture"]);
  }

  // ---- File nodes -----------------------------------------------------------
  for (const f of chosen) {
    const type = nodeTypeForRole(f.role);
    const id = `file-${fileSeq++}`;
    fileNodeId.set(f.path, id);
    const modKey = moduleKey(f.path);
    nodes.push({
      id,
      type,
      label: f.path.split("/").pop() || f.path,
      group: moduleId.get(modKey),
      description: describeFile(f.role, f.language),
      confidence: "high",
      layers: layersForNodeType(type),
      files: [f.path],
      position: place(type),
      metadata: { path: f.path, role: f.role, language: f.language, size: f.size }
    });
    const mid = moduleId.get(modKey);
    if (mid) addEdge(mid, id, "owns", ["architecture", "code"]);
  }

  // ---- Import edges (typed by endpoint roles) -------------------------------
  for (const e of input.graph.fileEdges) {
    const s = fileNodeId.get(e.from);
    const t = fileNodeId.get(e.to);
    if (!s || !t) continue;
    const { type, layers } = classifyEdge(roleByPath.get(e.from) || "other", roleByPath.get(e.to) || "other");
    addEdge(s, t, type, layers);
  }

  // ---- Aggregated logical edges (module ↔ module, feature ↔ feature) -------
  // The file→file imports above only surface on the (dense) Code layer. Roll
  // them up to their owning module / feature so the higher-level layers actually
  // show WHICH part depends on which — and in which direction — instead of a
  // bare project→feature→module hierarchy. Direction = source imports target,
  // i.e. the arrow points from the dependent to its dependency.
  const MAX_MODULE_EDGES = 240;
  const MAX_FEATURE_EDGES = 120;
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) || 0) + 1);
  const moduleDeps = new Map<string, number>();
  const featureDeps = new Map<string, number>();
  for (const e of input.graph.fileEdges) {
    const mf = moduleId.get(moduleKey(e.from));
    const mt = moduleId.get(moduleKey(e.to));
    if (mf && mt && mf !== mt) bump(moduleDeps, `${mf}\u0000${mt}`);
    const ff = featureByPath.get(e.from);
    const ft = featureByPath.get(e.to);
    if (ff && ft && ff !== ft) bump(featureDeps, `${ff}\u0000${ft}`);
  }
  const pushAggregated = (deps: Map<string, number>, cap: number, layers: LayerId[]) => {
    const top = [...deps.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
    for (const [key, weight] of top) {
      const [src, tgt] = key.split("\u0000");
      edges.push({
        id: `e-${edgeSeq++}`,
        source: src,
        target: tgt,
        type: "depends_on",
        // Weight = number of underlying imports, a hint at how strong the link is.
        label: weight > 1 ? `depends on \u00d7${weight}` : "depends on",
        layers
      });
    }
  };
  pushAggregated(moduleDeps, MAX_MODULE_EDGES, ["architecture", "feature"]);
  pushAggregated(featureDeps, MAX_FEATURE_EDGES, ["overview", "architecture", "feature"]);

  // ---- External packages ----------------------------------------------------
  const ext = Array.from(input.graph.externalUsage.entries())
    .map(([name, set]) => ({ name, files: Array.from(set) }))
    .filter((e) => e.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, MAX_EXTERNAL);
  const extBase = layersForNodeType("externalPackage");
  ext.forEach((pkg, i) => {
    const id = `pkg-${sanitize(pkg.name) || i}`;
    // Only the most-used packages stay on the (deliberately sparse) Overview layer.
    const layers = i < 8 ? extBase : extBase.filter((l) => l !== "overview");
    nodes.push({
      id,
      type: "externalPackage",
      label: pkg.name,
      description: `A third-party library the project relies on, used in ${pkg.files.length} file(s).`,
      confidence: "high",
      layers,
      files: pkg.files.slice(0, 50),
      position: place("externalPackage"),
      metadata: { package: pkg.name, usedBy: pkg.files.length }
    });
    let linked = 0;
    for (const p of pkg.files) {
      const fileId = fileNodeId.get(p);
      if (fileId && linked < MAX_USES_EDGES_PER_PKG) {
        addEdge(fileId, id, "uses", ["architecture"]);
        linked++;
      }
    }
  });

  // ---- Firebase functions + Firestore collections --------------------------
  // Synthesized (not 1:1 with a file): only when the stack actually uses
  // Firebase, so non-Firebase repos don't get spurious nodes.
  const hasFirebase = input.technologies.some((t) => /firebase|firestore/i.test(t.name));
  if (hasFirebase) {
    const fns = detectFirebaseFunctions(input.files);
    for (const fn of fns) {
      const id = `fn-${sanitize(fn.name) || fn.name}`;
      nodes.push({
        id,
        type: "firebaseFunction",
        label: fn.name,
        description: `A cloud function (${fn.kind}) that runs on the backend when called.`,
        confidence: "high",
        layers: layersForNodeType("firebaseFunction"),
        files: [fn.path],
        position: place("firebaseFunction"),
        metadata: { name: fn.name, kind: fn.kind, path: fn.path }
      });
      addEdge(projectId, id, "exposes", ["overview", "architecture"]);
      const defFile = fileNodeId.get(fn.path);
      if (defFile) addEdge(id, defFile, "calls", ["architecture", "dataFlow"]);
    }

    const collections = detectFirestoreCollections(input.files);
    for (const col of collections) {
      const id = `col-${sanitize(col.name) || col.name}`;
      nodes.push({
        id,
        type: "firestoreCollection",
        label: col.name,
        description: `A database collection where the app stores and reads "${col.name}" records.`,
        confidence: "high",
        layers: layersForNodeType("firestoreCollection"),
        files: [...col.writers, ...col.readers].slice(0, 50),
        position: place("firestoreCollection"),
        metadata: { collection: col.name, readers: col.readers.length, writers: col.writers.length }
      });
      // Keep the node connected on the (sparse) overview layer.
      addEdge(projectId, id, "owns", ["overview", "architecture"]);
      for (const p of col.writers) {
        const fid = fileNodeId.get(p);
        if (fid) addEdge(fid, id, "writes_to_db", ["architecture", "dataFlow"]);
      }
      for (const p of col.readers) {
        const fid = fileNodeId.get(p);
        if (fid) addEdge(fid, id, "reads_from_db", ["architecture", "dataFlow"]);
      }
    }
  }

  // ---- Risk layer tagging ---------------------------------------------------
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const tagRisk = (id: string) => {
    const n = nodeById.get(id);
    if (n && !n.layers.includes("risk")) {
      n.layers.push("risk");
      n.metadata.hasRisk = true;
    }
  };
  for (const insight of input.insights) {
    for (const p of insight.files || []) {
      const id = fileNodeId.get(p);
      if (id) tagRisk(id);
    }
    for (const id of insight.nodeIds || []) tagRisk(id);
  }

  return { nodes, edges };
}
