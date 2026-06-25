import { readMapPayload } from "./project-intelligence/storage/persist";
import type { IntelNode, NodeType } from "./project-intelligence/types";

// Builds a compact, token-bounded textual view of the project's GitHub-scan map
// (technologies, features, insights/risks, key structural nodes, stats) so the
// design and plan generators can actually reason over the project's structure
// instead of only the prose code summary. Returns "" when there is no completed
// scan, leaving the existing prompts unchanged.

// Total character budget for the whole map block (token/cost guard).
const MAP_CHAR_BUDGET = 4000;

// Per-section caps.
const MAX_TECHNOLOGIES = 25;
const MAX_FEATURES = 20;
const MAX_INSIGHTS = 15;
const MAX_NODES = 30;

// Structural node types worth surfacing to the LLM (skip leaf files / config /
// external packages — they add noise without structural signal).
const KEY_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "feature",
  "module",
  "component",
  "apiRoute",
  "dbModel",
  "service",
  "worker",
  "firebaseFunction",
  "firestoreCollection"
]);

// Single-line clip: collapses whitespace (for labels/descriptions on one line).
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Budget trim that preserves the block's newline structure.
function trimBudget(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nodeLine(n: IntelNode): string {
  const base = `- [${n.type}] ${clip(n.label, 80)}`;
  return n.description ? `${base}: ${clip(n.description, 120)}` : base;
}

export async function buildProjectMapContext(userId: string, projectId: string): Promise<string> {
  let payload;
  try {
    payload = await readMapPayload(userId, projectId);
  } catch {
    return "";
  }
  if (!payload || payload.status !== "completed" || !payload.nodes.length) return "";

  const sections: string[] = [];

  if (payload.technologies.length) {
    const techs = payload.technologies
      .slice(0, MAX_TECHNOLOGIES)
      .map((tech) => `${tech.name} (${tech.category})`)
      .join(", ");
    sections.push(`ТЕХНОЛОГИИ: ${techs}`);
  }

  if (payload.features.length) {
    const feats = payload.features
      .slice(0, MAX_FEATURES)
      .map((f) => (f.description ? `- ${clip(f.label, 60)}: ${clip(f.description, 120)}` : `- ${clip(f.label, 60)}`))
      .join("\n");
    sections.push(`ФУНКЦИОНАЛЬНОСТЬ:\n${feats}`);
  }

  if (payload.insights.length) {
    const risks = payload.insights
      .slice(0, MAX_INSIGHTS)
      .map((i) => `- [${i.severity}] ${clip(i.title, 80)}: ${clip(i.detail, 120)}`)
      .join("\n");
    sections.push(`ИНСАЙТЫ/РИСКИ:\n${risks}`);
  }

  const keyNodes = payload.nodes.filter((n) => KEY_NODE_TYPES.has(n.type)).slice(0, MAX_NODES);
  if (keyNodes.length) {
    sections.push(`КЛЮЧЕВЫЕ УЗЛЫ:\n${keyNodes.map(nodeLine).join("\n")}`);
  }

  const s = payload.stats;
  sections.push(
    `СТАТИСТИКА: файлов ${s.files}, узлов ${s.nodes}, связей ${s.edges}` +
      (s.risks != null ? `, рисков ${s.risks}` : "") +
      (s.technologies != null ? `, технологий ${s.technologies}` : "")
  );

  return trimBudget(sections.join("\n\n"), MAP_CHAR_BUDGET);
}
