import type { DesignMapEdge, DesignMapEdgeType, DesignMapNode } from "./types";

// Shape of the minimal project info we can use to seed an initial map. All
// fields besides `id` are optional — the builder degrades gracefully.
export interface InitialMapProject {
  id: string;
  name?: string;
  description?: string;
  stack?: string;
  summary?: string;
  repoUrl?: string;
  skillIds?: string[];
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

  // Skill nodes from project.skillIds (column 3), laid out in a grid so a long
  // list wraps into multiple columns instead of one very tall stack.
  const skillIds = project.skillIds ?? [];
  const skillBaseCol = COL_W * 3;
  const SKILLS_PER_COL = 8;
  skillIds.forEach((rawId, index) => {
    const skillId = String(rawId);
    const col = Math.floor(index / SKILLS_PER_COL);
    const row = index % SKILLS_PER_COL;
    const node: DesignMapNode = {
      id: `skill-${skillId}`,
      type: "skill",
      label: truncate(`Skill ${skillId}`, 200),
      position: { x: skillBaseCol + col * COL_W, y: row * ROW_H },
      skillId,
      confidence: "manual"
    };
    nodes.push(node);
    edges.push(edge(designNode.id, node.id, "uses"));
  });

  return { nodes, edges };
}
