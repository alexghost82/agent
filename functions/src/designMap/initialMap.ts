import type {
  DesignMapConfidence,
  DesignMapEdge,
  DesignMapEdgeType,
  DesignMapNode,
  DesignMapNodeType
} from "./types";

// Resolved skill the seeder can render as a real node. The caller (store) is
// responsible for ownership-checking these before passing them in.
export interface InitialMapSkill {
  id: string;
  skillName?: string;
  description?: string;
}

// Shape of the minimal project info we can use to seed an initial map. All
// fields besides `id` are optional — the builder degrades gracefully.
export interface InitialMapProject {
  id: string;
  name?: string;
  description?: string;
  stack?: string;
  summary?: string;
  repoUrl?: string;
  // Raw skill ids (back-compat). Used only when `skills` is not supplied; the
  // resulting node falls back to a generic `Skill <id>` label and no description.
  skillIds?: string[];
  // Enriched, ownership-checked skills. Preferred over `skillIds` so seeded
  // nodes carry the real skill name and description.
  skills?: InitialMapSkill[];
}

// Grid geometry: deterministic layout so two builds of the same project yield
// the same coordinates and no two nodes overlap.
const COL_W = 320;
const ROW_H = 160;

function edge(source: string, target: string, type: DesignMapEdgeType): DesignMapEdge {
  return { id: `e-${source}-${target}`, source, target, type };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildInitialDesignMap(project: InitialMapProject): {
  nodes: DesignMapNode[];
  edges: DesignMapEdge[];
} {
  const nodes: DesignMapNode[] = [];
  const edges: DesignMapEdge[] = [];

  // Root project node (column 0).
  const projectNode: DesignMapNode = {
    id: "project",
    type: "project",
    label: truncate(project.name || "Project", 200),
    description: project.description ? truncate(project.description, 5000) : undefined,
    position: { x: 0, y: 0 },
    confidence: "manual",
    data: { projectId: project.id }
  };
  nodes.push(projectNode);

  // Design section node (column 1), contained by the project.
  const designNode: DesignMapNode = {
    id: "design_section",
    type: "design_section",
    label: "Design",
    description: "Groups the project's design: its features, modules, screens and skills.",
    position: { x: COL_W, y: 0 },
    confidence: "manual"
  };
  nodes.push(designNode);
  edges.push(edge(projectNode.id, designNode.id, "contains"));

  // Feature/module nodes derived from available project info (column 2). Laid
  // out top-to-bottom so they never collide.
  let featureRow = 0;
  const featureCol = COL_W * 2;
  const addFeature = (
    idSuffix: string,
    type: "feature" | "module",
    label: string,
    description?: string
  ) => {
    const node: DesignMapNode = {
      id: `feature-${idSuffix}`,
      type,
      label: truncate(label, 200),
      description: description ? truncate(description, 5000) : undefined,
      position: { x: featureCol, y: featureRow * ROW_H },
      confidence: "low"
    };
    nodes.push(node);
    edges.push(edge(designNode.id, node.id, "contains"));
    featureRow += 1;
  };

  if (project.description) {
    addFeature("desc", "feature", "Overview", project.description);
  }
  if (project.summary) {
    addFeature("summary", "feature", "Summary", project.summary);
  }
  if (project.stack) {
    addFeature("stack", "module", `Stack: ${project.stack}`, project.stack);
  }
  if (project.repoUrl) {
    addFeature("repo", "module", "Repository", project.repoUrl);
  }

  // Skill nodes (column 3), laid out in a grid so a long list wraps into
  // multiple columns instead of one very tall stack. Prefer the enriched
  // `skills` (real name + description); fall back to raw `skillIds`.
  const skills: InitialMapSkill[] =
    project.skills ?? (project.skillIds ?? []).map((rawId) => ({ id: String(rawId) }));
  const skillBaseCol = COL_W * 3;
  const SKILLS_PER_COL = 8;
  skills.forEach((skill, index) => {
    const skillId = String(skill.id);
    const col = Math.floor(index / SKILLS_PER_COL);
    const row = index % SKILLS_PER_COL;
    const label = skill.skillName ? truncate(skill.skillName, 200) : truncate(`Skill ${skillId}`, 200);
    const node: DesignMapNode = {
      id: `skill-${skillId}`,
      type: "skill",
      label,
      description: skill.description ? truncate(skill.description, 5000) : undefined,
      position: { x: skillBaseCol + col * COL_W, y: row * ROW_H },
      skillId,
      confidence: "manual"
    };
    nodes.push(node);
    edges.push(edge(designNode.id, node.id, "uses"));
  });

  return { nodes, edges };
}

/* -------------------------------------------------------------------------- */
/* Seeding from a Project Intelligence scan graph                             */
/* -------------------------------------------------------------------------- */

// Trimmed view of a scan graph node consumed by the seeder. Types are plain
// strings (the intel NodeType / EdgeType unions) so this module stays decoupled
// from the project-intelligence package — the mapping tables below own the
// translation into the design-map vocabulary.
export interface ScanGraphNodeInput {
  id: string;
  type: string;
  label: string;
  description?: string;
  confidence?: string;
}

export interface ScanGraphEdgeInput {
  id?: string;
  source: string;
  target: string;
  type: string;
}

export interface ScanGraphInput {
  nodes: ScanGraphNodeInput[];
  edges: ScanGraphEdgeInput[];
}

// intel NodeType -> DesignMapNodeType. Anything not listed falls back to "note"
// (file, config, test, documentation, externalPackage, …). The intel "project"
// node is handled specially (folded into the design map root) and intentionally
// omitted here.
const INTEL_NODE_TYPE: Record<string, DesignMapNodeType> = {
  feature: "feature",
  module: "module",
  apiRoute: "api_route",
  service: "module",
  worker: "module",
  firebaseFunction: "module",
  dbModel: "database",
  firestoreCollection: "database",
  component: "component"
};

function mapNodeType(intelType: string): DesignMapNodeType {
  return INTEL_NODE_TYPE[intelType] ?? "note";
}

// intel EdgeType -> DesignMapEdgeType. Ownership/containment collapses to
// "contains", import/dependency to "depends_on", call/usage to "uses"; anything
// else relates loosely via "related_to".
const INTEL_EDGE_TYPE: Record<string, DesignMapEdgeType> = {
  owns: "contains",
  exposes: "contains",
  contains: "contains",
  renders: "contains",
  uses: "uses",
  calls: "uses",
  reads_from_db: "uses",
  writes_to_db: "uses",
  depends_on: "depends_on",
  imports: "depends_on",
  configured_by: "depends_on",
  tested_by: "related_to"
};

function mapEdgeType(intelType: string): DesignMapEdgeType {
  return INTEL_EDGE_TYPE[intelType] ?? "related_to";
}

// intel Confidence -> DesignMapConfidence. "inferred" (AI-only, never confirmed
// by code) and anything unknown degrade to "low".
function mapConfidence(c?: string): DesignMapConfidence {
  return c === "high" || c === "medium" || c === "low" ? c : "low";
}

// Layout + size bounds for the derived map. ROWS_PER_COL keeps each design-type
// column a readable height; MAX_INTEL_NODES keeps the seeded map within the
// editor's 500-item save cap (project + design_section + skills + intel nodes).
const ROWS_PER_COL = 12;
const MAX_INTEL_NODES = 400;
const MAX_SKILL_NODES = 80;

// Translate a Project Intelligence scan graph into an initial design map. Pure +
// deterministic (stable id order in, stable ids/positions out) so it can be
// unit-tested without Firebase. The intel project node folds into the design map
// root; remaining intel nodes are typed via the mapping tables, laid out on a
// non-overlapping grid, and connected by the translated edges. The project's
// own skills are still surfaced as skill nodes (as in the thin seed) so the
// add-skill flow's anchor/idempotency keeps working; enriched `skills` (real
// name + description) are preferred over raw `skillIds` when available.
export function buildDesignMapFromScanGraph(
  project: InitialMapProject,
  graph: ScanGraphInput
): { nodes: DesignMapNode[]; edges: DesignMapEdge[] } {
  const nodes: DesignMapNode[] = [];
  const edges: DesignMapEdge[] = [];
  // intel node id -> design map node id.
  const idMap = new Map<string, string>();

  // Root project node (column 0) — folds in the intel project node if present.
  const projectNode: DesignMapNode = {
    id: "project",
    type: "project",
    label: truncate(project.name || "Project", 200),
    description: project.description ? truncate(project.description, 5000) : undefined,
    position: { x: 0, y: 0 },
    confidence: "manual",
    data: { projectId: project.id }
  };
  nodes.push(projectNode);

  // Design section anchor (column 1), contained by the project.
  const designNode: DesignMapNode = {
    id: "design_section",
    type: "design_section",
    label: "Design",
    position: { x: COL_W, y: 0 },
    confidence: "manual"
  };
  nodes.push(designNode);
  edges.push(edge(projectNode.id, designNode.id, "contains"));

  // Fold every intel "project" node into the design map root so its outgoing
  // ownership edges reattach to "project" instead of producing a duplicate root.
  for (const n of graph.nodes) {
    if (n.type === "project") idMap.set(n.id, projectNode.id);
  }

  // Translate the remaining intel nodes onto a deterministic grid (columns from
  // index 2 onward). Capped so a huge graph can't blow past the save limit.
  const intelNodes = graph.nodes.filter((n) => n.type !== "project").slice(0, MAX_INTEL_NODES);
  intelNodes.forEach((n, index) => {
    const designId = `intel-${n.id}`;
    idMap.set(n.id, designId);
    const col = 2 + Math.floor(index / ROWS_PER_COL);
    const row = index % ROWS_PER_COL;
    nodes.push({
      id: designId,
      type: mapNodeType(n.type),
      label: truncate(n.label || designId, 200),
      description: n.description ? truncate(n.description, 5000) : undefined,
      position: { x: col * COL_W, y: row * ROW_H },
      confidence: mapConfidence(n.confidence)
    });
  });

  // Translate intel edges, dropping any whose endpoints didn't survive the cap
  // and de-duplicating on the synthesized edge id.
  const seenEdge = new Set(edges.map((e) => e.id));
  for (const e of graph.edges) {
    const source = idMap.get(e.source);
    const target = idMap.get(e.target);
    if (!source || !target || source === target) continue;
    const type = mapEdgeType(e.type);
    const id = `e-${source}-${target}-${type}`;
    if (seenEdge.has(id)) continue;
    seenEdge.add(id);
    edges.push({ id, source, target, type });
  }

  // Skill nodes, placed beyond the intel columns so they never overlap, and
  // hung off the design anchor (mirrors the thin seed). Prefer enriched `skills`
  // (real name + description) over raw `skillIds`.
  const skills: InitialMapSkill[] = (
    project.skills ?? (project.skillIds ?? []).map((rawId) => ({ id: String(rawId) }))
  ).slice(0, MAX_SKILL_NODES);
  const intelCols = Math.ceil(intelNodes.length / ROWS_PER_COL);
  const skillBaseCol = 2 + intelCols + 1;
  const SKILLS_PER_COL = 8;
  skills.forEach((skill, index) => {
    const skillId = String(skill.id);
    const col = Math.floor(index / SKILLS_PER_COL);
    const row = index % SKILLS_PER_COL;
    const label = skill.skillName ? truncate(skill.skillName, 200) : truncate(`Skill ${skillId}`, 200);
    const node: DesignMapNode = {
      id: `skill-${skillId}`,
      type: "skill",
      label,
      description: skill.description ? truncate(skill.description, 5000) : undefined,
      position: { x: (skillBaseCol + col) * COL_W, y: row * ROW_H },
      skillId,
      confidence: "manual"
    };
    nodes.push(node);
    const edgeId = `e-${designNode.id}-${node.id}`;
    if (!seenEdge.has(edgeId)) {
      seenEdge.add(edgeId);
      edges.push(edge(designNode.id, node.id, "uses"));
    }
  });

  return { nodes, edges };
}
