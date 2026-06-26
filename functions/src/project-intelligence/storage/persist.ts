import { db } from "../../firebase";
import { serverTime } from "../../util";
import { tsMillis } from "../../pure";
import type {
  ScanStatus,
  ScanOptions,
  NodeType,
  IntelNode,
  IntelEdge,
  Technology,
  Feature,
  Insight,
  FileIndexEntry,
  MapPayload,
  MapRisk,
  MapDependency,
  MapGroup
} from "../types";

// Firestore collections for the project-intelligence feature. Every doc is
// scoped by userId + projectId (+ scanId) so reads stay tenant-isolated.
export const SCAN_COLLECTIONS = [
  "project_scans",
  "project_maps",
  "project_nodes",
  "project_edges",
  "project_technologies",
  "project_features",
  "project_insights",
  "project_file_index"
] as const;

const WRITE_BATCH = 400;

/* -------------------------------------------------------------------------- */
/* Scan lifecycle                                                             */
/* -------------------------------------------------------------------------- */

export async function createScan(
  userId: string,
  projectId: string,
  scanToken: string,
  options: ScanOptions
): Promise<string> {
  const ref = await db.collection("project_scans").add({
    userId,
    projectId,
    status: "pending" as ScanStatus,
    phase: "queued",
    scanToken,
    options: { maxDepth: options.maxDepth ?? null, ai: options.ai ?? false },
    progressDone: 0,
    progressTotal: 0,
    error: null,
    counts: null,
    createdAt: serverTime(),
    updatedAt: serverTime()
  });
  return ref.id;
}

export async function updateScan(scanId: string, patch: Record<string, unknown>): Promise<void> {
  await db.collection("project_scans").doc(scanId).set({ ...patch, updatedAt: serverTime() }, { merge: true });
}

export async function getScan(scanId: string): Promise<FirebaseFirestore.DocumentSnapshot> {
  return db.collection("project_scans").doc(scanId).get();
}

// Latest scan for a project (newest by createdAt), tenant-checked by the caller.
export async function readLatestScan(
  userId: string,
  projectId: string
): Promise<(FirebaseFirestore.DocumentData & { id: string }) | null> {
  const snap = await db
    .collection("project_scans")
    .where("userId", "==", userId)
    .where("projectId", "==", projectId)
    .limit(50)
    .get();
  if (snap.empty) return null;
  const docs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => tsMillis((b as any).createdAt) - tsMillis((a as any).createdAt));
  return docs[0] as FirebaseFirestore.DocumentData & { id: string };
}

// Latest COMPLETED scan for a project (newest by createdAt). Unlike
// readLatestScan this ignores pending / running / failed scans, so callers that
// need a finished graph (e.g. seeding the design map) never read a half-written
// or empty snapshot. Same query shape as readLatestScan; filtered + sorted
// in-memory so no composite index is required.
export async function readLatestCompletedScan(
  userId: string,
  projectId: string
): Promise<(FirebaseFirestore.DocumentData & { id: string }) | null> {
  const snap = await db
    .collection("project_scans")
    .where("userId", "==", userId)
    .where("projectId", "==", projectId)
    .limit(50)
    .get();
  if (snap.empty) return null;
  const docs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => (d as any).status === "completed")
    .sort((a, b) => tsMillis((b as any).createdAt) - tsMillis((a as any).createdAt));
  return (docs[0] as FirebaseFirestore.DocumentData & { id: string }) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Deletion helpers                                                           */
/* -------------------------------------------------------------------------- */

async function deleteByQuery(query: FirebaseFirestore.Query): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await query.limit(WRITE_BATCH).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < WRITE_BATCH) break;
  }
  return deleted;
}

// Remove all graph data (but NOT the scan status docs) for a project, so a new
// scan supersedes the previous graph without unbounded growth.
async function purgeGraphData(userId: string, projectId: string): Promise<void> {
  for (const collection of ["project_maps", "project_nodes", "project_edges", "project_technologies", "project_features", "project_insights", "project_file_index"]) {
    await deleteByQuery(
      db.collection(collection).where("userId", "==", userId).where("projectId", "==", projectId)
    );
  }
}

// Full purge (incl. scan status) — used when a project itself is deleted.
export async function purgeProjectIntel(userId: string, projectId: string): Promise<number> {
  let total = 0;
  for (const collection of SCAN_COLLECTIONS) {
    total += await deleteByQuery(
      db.collection(collection).where("userId", "==", userId).where("projectId", "==", projectId)
    );
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Persisting a completed scan's graph                                        */
/* -------------------------------------------------------------------------- */

export interface PersistGraphInput {
  userId: string;
  projectId: string;
  scanId: string;
  nodes: IntelNode[];
  edges: IntelEdge[];
  technologies: Technology[];
  features: Feature[];
  insights: Insight[];
  fileIndex: FileIndexEntry[];
}

interface RelatedRef {
  id: string;
  label: string;
  type: string;
  edgeType: string;
  direction: "out" | "in";
}

// Caps for the synthesized per-node `details` block so a huge/god node can't
// blow up the doc size or the exported Markdown.
const DETAIL_TEXT_CAP = 600;
const DETAIL_LIST_CAP = 40;
const DETAIL_FILE_CAP = 60;

function clampText(s: string, cap = DETAIL_TEXT_CAP): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1)}\u2026`;
}

// One-line "what this node does" hint keyed off the node type. Deterministic and
// transport-friendly so it can be exported without further processing.
function logicForType(type: NodeType): string {
  const map: Partial<Record<NodeType, string>> = {
    project: "Root of the project graph; owns features and top-level functions.",
    feature: "Groups the files that implement one product capability.",
    module: "A directory-level grouping of related source files.",
    apiRoute: "Handles an inbound request and returns a response.",
    firebaseFunction: "Deployed Cloud Function entrypoint invoked at runtime.",
    service: "Encapsulates business logic called by routes and workers.",
    worker: "Runs background / queued work out of the request path.",
    dbModel: "Defines a persisted data shape / schema.",
    firestoreCollection: "A Firestore collection read from / written to by code.",
    component: "Renders part of the UI.",
    config: "Configures build, runtime or deployment behaviour.",
    test: "Verifies behaviour of the code it imports.",
    documentation: "Human-readable documentation.",
    externalPackage: "Third-party dependency imported by the project.",
    file: "Source file in the repository."
  };
  return map[type] || "Source element in the project graph.";
}

interface NodeDetailBlock {
  purpose: string;
  usage: string;
  stack: string[];
  inputs: string[];
  outputs: string[];
  logic: string;
  risks: string[];
  files: string[];
}

function buildNodeDetails(
  node: IntelNode,
  related: RelatedRef[],
  risks: { title: string; severity: string; detail: string }[],
  topTechnologies: string[]
): NodeDetailBlock {
  const edgeLabel = (e: string) => e.replace(/_/g, " ");
  const inputs = related
    .filter((r) => r.direction === "in")
    .slice(0, DETAIL_LIST_CAP)
    .map((r) => clampText(`${edgeLabel(r.edgeType)} \u2190 ${r.label}`, 160));
  const outputs = related
    .filter((r) => r.direction === "out")
    .slice(0, DETAIL_LIST_CAP)
    .map((r) => clampText(`${edgeLabel(r.edgeType)} \u2192 ${r.label}`, 160));

  const stack = new Set<string>();
  const lang = node.metadata?.language;
  if (typeof lang === "string" && lang) stack.add(lang);
  const role = node.metadata?.role;
  if (typeof role === "string" && role && role !== "other") stack.add(role);
  // The project root summarises the whole stack.
  if (node.type === "project") for (const t of topTechnologies) stack.add(t);

  return {
    purpose: clampText(node.description || logicForType(node.type)),
    // Human "how / when it's used" — AI-provided when available, otherwise a
    // plain per-type sentence so the field is never empty.
    usage: clampText(node.usage || logicForType(node.type)),
    stack: Array.from(stack).slice(0, DETAIL_LIST_CAP),
    inputs,
    outputs,
    logic: logicForType(node.type),
    risks: risks.map((r) => clampText(`${r.title}: ${r.detail}`, 240)).slice(0, DETAIL_LIST_CAP),
    files: node.files.slice(0, DETAIL_FILE_CAP)
  };
}

// Technical reference shown subtly under the (human) node label on the card:
// the original file path / module key / package name. Kept so the structural
// pointer isn't lost once `label` becomes a human name.
function nodeSubtitle(n: IntelNode): string | null {
  const path = n.metadata?.path;
  if (typeof path === "string" && path) return path;
  const key = n.metadata?.key;
  if (typeof key === "string" && key) return key;
  if (n.files.length) return n.files[0];
  return null;
}

// Light node shape stored in the fast-read snapshot (no description/files — those
// are fetched lazily from project_nodes on click). `subtitle` carries the
// technical file reference so the card can show it under the human label.
function lightNode(n: IntelNode) {
  return {
    id: n.id,
    type: n.type,
    label: n.label,
    subtitle: nodeSubtitle(n),
    group: n.group ?? null,
    confidence: n.confidence,
    layers: n.layers,
    position: n.position,
    hasRisk: !!n.metadata?.hasRisk
  };
}

export async function persistScanGraph(input: PersistGraphInput): Promise<void> {
  const { userId, projectId, scanId } = input;
  await purgeGraphData(userId, projectId);

  const base = { userId, projectId, scanId, createdAt: serverTime() };

  // Snapshot (single fast-read doc for GET /scan/map).
  await db.collection("project_maps").doc(scanId).set({
    ...base,
    nodes: input.nodes.map(lightNode),
    edges: input.edges,
    technologies: input.technologies,
    features: input.features.map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      description: f.description ?? null,
      confidence: f.confidence,
      fileCount: f.files.length
    })),
    insights: input.insights,
    stats: { files: input.fileIndex.length, nodes: input.nodes.length, edges: input.edges.length }
  });

  // Normalized container docs (one per scan) for the spec'd models.
  await db.collection("project_edges").doc(scanId).set({ ...base, edges: input.edges });
  await db.collection("project_technologies").doc(scanId).set({ ...base, technologies: input.technologies });
  await db.collection("project_features").doc(scanId).set({ ...base, features: input.features });
  await db.collection("project_insights").doc(scanId).set({ ...base, insights: input.insights });
  await db.collection("project_file_index").doc(scanId).set({ ...base, files: input.fileIndex.slice(0, 4000) });

  // Precompute per-node relations + risks so the sidebar is a single read.
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const related = new Map<string, RelatedRef[]>();
  const pushRelated = (key: string, ref: RelatedRef) => {
    const list = related.get(key);
    if (list) list.push(ref);
    else related.set(key, [ref]);
  };
  for (const e of input.edges) {
    const s = nodeById.get(e.source);
    const t = nodeById.get(e.target);
    if (!s || !t) continue;
    pushRelated(e.source, { id: t.id, label: t.label, type: t.type, edgeType: e.type, direction: "out" });
    pushRelated(e.target, { id: s.id, label: s.label, type: s.type, edgeType: e.type, direction: "in" });
  }
  const risksByNode = new Map<string, { title: string; severity: string; detail: string }[]>();
  for (const ins of input.insights) {
    const targets = new Set<string>(ins.nodeIds || []);
    for (const f of ins.files || []) {
      for (const n of input.nodes) if (n.files.includes(f)) targets.add(n.id);
    }
    for (const id of targets) {
      if (!risksByNode.has(id)) risksByNode.set(id, []);
      risksByNode.get(id)!.push({ title: ins.title, severity: ins.severity, detail: ins.detail });
    }
  }

  // Top technologies feed the project-root node's `stack` detail.
  const topTechnologies = input.technologies.slice(0, 12).map((t) => t.name);

  // Per-node detail docs (lazy-loaded). Doc id = `${scanId}__${nodeId}`.
  for (let i = 0; i < input.nodes.length; i += WRITE_BATCH) {
    const slice = input.nodes.slice(i, i + WRITE_BATCH);
    const batch = db.batch();
    for (const n of slice) {
      const ref = db.collection("project_nodes").doc(`${scanId}__${n.id}`);
      const nodeRelated = (related.get(n.id) || []).slice(0, 60);
      const nodeRisks = risksByNode.get(n.id) || [];
      batch.set(ref, {
        ...base,
        nodeId: n.id,
        type: n.type,
        label: n.label,
        subtitle: nodeSubtitle(n),
        group: n.group ?? null,
        description: n.description ?? null,
        usage: n.usage ?? null,
        confidence: n.confidence,
        layers: n.layers,
        files: n.files,
        metadata: n.metadata,
        related: nodeRelated,
        risks: nodeRisks,
        // Synthesized "Read more" block: purpose / stack / inputs / outputs /
        // logic / risks / files. Capped (see buildNodeDetails) so it stays small.
        details: buildNodeDetails(n, nodeRelated, nodeRisks, topTechnologies)
      });
    }
    await batch.commit();
  }
}

/* -------------------------------------------------------------------------- */
/* Reads for the API                                                          */
/* -------------------------------------------------------------------------- */

// Map an Insight (stored on the snapshot) to a human-readable risk row.
function insightToRisk(ins: Insight): MapRisk {
  return {
    id: ins.id,
    title: ins.title,
    severity: ins.severity,
    detail: ins.detail,
    files: ins.files,
    nodeIds: ins.nodeIds
  };
}

// Derive third-party dependencies from the externalPackage nodes in the graph.
function dependenciesFromNodes(nodes: any[]): MapDependency[] {
  return nodes
    .filter((n) => n.type === "externalPackage")
    .map((n) => ({
      name: String(n.label || n.id),
      category: "other" as const,
      usedBy: Number((n.metadata && n.metadata.usedBy) ?? 0) || undefined,
      confidence: n.confidence
    }))
    .sort((a, b) => (b.usedBy ?? 0) - (a.usedBy ?? 0));
}

// Collapse `node.group` handles into named groups (label = parent node label).
function groupsFromNodes(nodes: any[]): MapGroup[] {
  const labelById = new Map<string, string>();
  for (const n of nodes) labelById.set(String(n.id), String(n.label || n.id));
  const members = new Map<string, string[]>();
  for (const n of nodes) {
    const g = n.group ? String(n.group) : "";
    if (!g) continue;
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(String(n.id));
  }
  return Array.from(members.entries()).map(([id, nodeIds]) => ({
    id,
    label: labelById.get(id) || id,
    nodeIds
  }));
}

export async function readMapPayload(userId: string, projectId: string): Promise<MapPayload | null> {
  const scan = await readLatestScan(userId, projectId);
  if (!scan) return null;
  const status = (scan.status as ScanStatus) || "pending";
  const mapDoc = await db.collection("project_maps").doc(scan.id).get();

  // Project-level summary (best-effort; never blocks the map render).
  let summary: string | null = null;
  try {
    const proj = await db.collection("projects").doc(projectId).get();
    const pdata = proj.data();
    if (proj.exists && pdata?.userId === userId && typeof pdata?.summary === "string") {
      summary = pdata.summary as string;
    }
  } catch {
    summary = null;
  }

  if (!mapDoc.exists) {
    // Scan exists but no graph yet (still running / failed).
    return {
      scanId: scan.id,
      status,
      summary,
      nodes: [],
      edges: [],
      technologies: [],
      features: [],
      insights: [],
      dependencies: [],
      risks: [],
      groups: [],
      fileIndex: [],
      stats: { files: 0, nodes: 0, edges: 0, risks: 0, technologies: 0 }
    };
  }
  const data = mapDoc.data() || {};
  if (data.userId !== userId) return null;

  const nodes = (data.nodes as any[]) || [];
  const edges = (data.edges as any[]) || [];
  const technologies = (data.technologies as Technology[]) || [];
  const features = (data.features as Feature[]) || [];
  const insights = (data.insights as Insight[]) || [];
  const baseStats = (data.stats as MapPayload["stats"]) || { files: 0, nodes: 0, edges: 0 };

  // File index lives in its own (potentially large) doc; read + cap for transport.
  let fileIndex: FileIndexEntry[] = [];
  try {
    const fiDoc = await db.collection("project_file_index").doc(scan.id).get();
    const fiData = fiDoc.data();
    if (fiDoc.exists && fiData?.userId === userId) {
      fileIndex = ((fiData.files as FileIndexEntry[]) || []).slice(0, 2000);
    }
  } catch {
    fileIndex = [];
  }

  const risks = insights.map(insightToRisk);
  const dependencies = dependenciesFromNodes(nodes);
  const groups = groupsFromNodes(nodes);

  return {
    scanId: scan.id,
    status,
    generatedAt: tsMillis(data.createdAt) || undefined,
    summary,
    nodes,
    edges,
    technologies,
    features,
    insights,
    dependencies,
    risks,
    groups,
    fileIndex,
    stats: {
      files: baseStats.files ?? fileIndex.length,
      nodes: baseStats.nodes ?? nodes.length,
      edges: baseStats.edges ?? edges.length,
      risks: risks.length,
      technologies: technologies.length
    }
  };
}

export async function readNodeDetail(
  userId: string,
  projectId: string,
  nodeId: string
): Promise<Record<string, unknown> | null> {
  const scan = await readLatestScan(userId, projectId);
  if (!scan) return null;
  const doc = await db.collection("project_nodes").doc(`${scan.id}__${nodeId}`).get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  if (data.userId !== userId || data.projectId !== projectId) return null;
  return { id: doc.id, ...data };
}

/* -------------------------------------------------------------------------- */
/* Scan graph read for design-map seeding                                     */
/* -------------------------------------------------------------------------- */

// A trimmed, transport-light view of a scan's graph, sufficient to translate
// into a design map: node type/label/description + edge type/endpoints. (No
// positions — the design map computes its own deterministic layout.) Types are
// intentionally widened to plain strings so consumers in other packages can map
// them without importing the project-intelligence enums.
export interface ScanGraphNodeView {
  id: string;
  type: string;
  label: string;
  description?: string;
  usage?: string;
  confidence?: string;
}

export interface ScanGraphEdgeView {
  id: string;
  source: string;
  target: string;
  type: string;
}

export interface ScanGraphView {
  scanId: string;
  nodes: ScanGraphNodeView[];
  edges: ScanGraphEdgeView[];
}

// Upper bound on the number of nodes hydrated for a design-map seed. Bounds both
// the per-node description reads (getAll) and the size of the seeded map so it
// stays within the editor's 500-item save cap (see designMap/validators.ts).
const DESIGN_SEED_NODE_CAP = 400;

// Rank intel node types so that, when a graph exceeds the cap, the most
// architecturally meaningful nodes survive and bulk file/test nodes are dropped
// first. Lower = kept first. The project root is always rank 0.
const SEED_TYPE_PRIORITY: Record<string, number> = {
  project: 0,
  feature: 1,
  apiRoute: 2,
  firebaseFunction: 3,
  service: 4,
  worker: 5,
  dbModel: 6,
  firestoreCollection: 7,
  module: 8,
  component: 9,
  externalPackage: 10,
  config: 11,
  documentation: 12,
  test: 13,
  file: 14
};

function seedPriority(type: string): number {
  return SEED_TYPE_PRIORITY[type] ?? 99;
}

// Read the latest COMPLETED scan's graph for a project, hydrated with per-node
// descriptions, for the design-map seeder. Returns null when there is no
// completed scan or no persisted graph snapshot (graceful fallback for the
// caller). Ownership is enforced at the data layer (snapshot + node docs are
// tenant-checked) and only structural fields are read — never file contents or
// secrets.
export async function readLatestCompletedScanGraph(
  userId: string,
  projectId: string
): Promise<ScanGraphView | null> {
  const scan = await readLatestCompletedScan(userId, projectId);
  if (!scan) return null;

  const mapDoc = await db.collection("project_maps").doc(scan.id).get();
  if (!mapDoc.exists) return null;
  const data = mapDoc.data() || {};
  if (data.userId !== userId) return null;

  const lightNodes = (data.nodes as any[]) || [];
  const rawEdges = (data.edges as any[]) || [];
  if (lightNodes.length === 0) return null;

  // Keep the most meaningful nodes when the graph is large: stable sort by type
  // priority then id, then cap. Bounds the description reads below.
  const kept = [...lightNodes]
    .sort((a, b) => {
      const pa = seedPriority(String(a?.type));
      const pb = seedPriority(String(b?.type));
      if (pa !== pb) return pa - pb;
      return String(a?.id).localeCompare(String(b?.id));
    })
    .slice(0, DESIGN_SEED_NODE_CAP);

  // Hydrate descriptions + usage from the per-node detail docs in a single
  // batched read.
  const descById = new Map<string, string>();
  const usageById = new Map<string, string>();
  const refs = kept.map((n) =>
    db.collection("project_nodes").doc(`${scan.id}__${String(n.id)}`)
  );
  if (refs.length) {
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (!doc.exists) continue;
      const d = doc.data() || {};
      if (d.userId !== userId) continue;
      const purpose =
        (d.details && typeof d.details.purpose === "string" && d.details.purpose) || "";
      const description =
        (typeof d.description === "string" && d.description) || purpose || "";
      if (description) descById.set(String(d.nodeId), description);
      const usage =
        (typeof d.usage === "string" && d.usage) ||
        (d.details && typeof d.details.usage === "string" && d.details.usage) ||
        "";
      if (usage) usageById.set(String(d.nodeId), usage);
    }
  }

  const keptIds = new Set(kept.map((n) => String(n.id)));
  const nodes: ScanGraphNodeView[] = kept.map((n) => {
    const id = String(n.id);
    const description = descById.get(id);
    const usage = usageById.get(id);
    return {
      id,
      type: String(n.type),
      label: String(n.label ?? id),
      ...(description ? { description } : {}),
      ...(usage ? { usage } : {}),
      ...(n.confidence ? { confidence: String(n.confidence) } : {})
    };
  });

  // Only keep edges whose BOTH endpoints survived the cap (no dangling edges).
  const edges: ScanGraphEdgeView[] = rawEdges
    .filter((e) => keptIds.has(String(e?.source)) && keptIds.has(String(e?.target)))
    .map((e) => ({
      id: String(e.id ?? `${e.source}->${e.target}`),
      source: String(e.source),
      target: String(e.target),
      type: String(e.type ?? "related_to")
    }));

  return { scanId: scan.id, nodes, edges };
}
