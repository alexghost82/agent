import type { Node, Edge } from "@xyflow/react";

export type FlowSeedKind = "design" | "project";

const MAX_NODES = 20;
const COL_X = 120;
const ROW_GAP = 110;
const BRANCH_X = 420;

function makeNode(id: string, label: string, x: number, y: number): Node {
  return { id, position: { x, y }, data: { label }, type: "default" };
}

function makeEdge(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, target };
}

function clip(text: string, max = 40): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}\u2026`;
}

// Split free-form design output into readable sections. We look for numbered
// list items (`1)` / `1.`), markdown headings (`#`, `##`) and bullet markers;
// otherwise we fall back to non-empty lines.
function splitSections(text: string): string[] {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sections: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      sections.push(line.replace(/^#{1,6}\s+/, ""));
    } else if (/^\d+\s*[).]\s+/.test(line)) {
      sections.push(line.replace(/^\d+\s*[).]\s+/, ""));
    } else if (/^[-*\u2022]\s+/.test(line)) {
      sections.push(line.replace(/^[-*\u2022]\s+/, ""));
    } else {
      sections.push(line);
    }
    if (sections.length >= 8) break;
  }
  return sections;
}

function seedDesign(data: any): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const projectName = clip(data?.projectName || "Design", 40);
  const rootId = "n-root";
  nodes.push(makeNode(rootId, projectName, COL_X, 0));

  const sections = splitSections(data?.designText || "");
  let prevId = rootId;
  let row = 1;
  if (sections.length === 0) {
    const placeholderId = "n-design";
    nodes.push(makeNode(placeholderId, "Design", COL_X, ROW_GAP));
    edges.push(makeEdge(rootId, placeholderId));
    prevId = placeholderId;
    row = 2;
  } else {
    sections.slice(0, 8).forEach((section, i) => {
      const id = `n-sec-${i}`;
      nodes.push(makeNode(id, clip(section), COL_X, row * ROW_GAP));
      edges.push(makeEdge(prevId, id));
      prevId = id;
      row += 1;
    });
  }

  // Skills branch off the root node so they read as supporting context.
  const skills = Array.isArray(data?.skills) ? data.skills : [];
  let branchRow = 0;
  for (const skill of skills) {
    if (nodes.length >= MAX_NODES) break;
    const name = clip(skill?.skillName || "", 40);
    if (!name) continue;
    const id = `n-skill-${branchRow}`;
    nodes.push(makeNode(id, name, BRANCH_X, branchRow * ROW_GAP));
    edges.push(makeEdge(rootId, id));
    branchRow += 1;
  }

  return { nodes, edges };
}

function seedProject(data: any): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const rootId = "n-root";
  nodes.push(makeNode(rootId, clip(data?.name || "Project", 40), COL_X, 0));

  let row = 1;
  const pushChild = (id: string, label: string) => {
    if (nodes.length >= MAX_NODES) return;
    nodes.push(makeNode(id, clip(label), BRANCH_X, row * ROW_GAP));
    edges.push(makeEdge(rootId, id));
    row += 1;
  };

  if (data?.stack) pushChild("n-stack", String(data.stack));

  const skills = Array.isArray(data?.skills) ? data.skills.slice(0, 8) : [];
  skills.forEach((skill: any, i: number) => {
    const name = skill?.skillName || "";
    if (name) pushChild(`n-skill-${i}`, String(name));
  });

  const plans = Array.isArray(data?.plans) ? data.plans.slice(0, 6) : [];
  plans.forEach((plan: any, i: number) => {
    const title = plan?.title || `Plan ${i + 1}`;
    pushChild(`n-plan-${i}`, String(title));
  });

  return { nodes, edges };
}

/**
 * Convert existing app data into an initial, readable flow map. Returns nodes
 * and edges ready to hand to <FlowMap initialNodes initialEdges />.
 */
export function seedFlow(kind: FlowSeedKind, data: any): { nodes: Node[]; edges: Edge[] } {
  return kind === "design" ? seedDesign(data) : seedProject(data);
}
