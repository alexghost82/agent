import { llm } from "../../ai";
import { safeJsonObject, safeJsonArray } from "../../pure";
import { log } from "../../log";
import type { IntelNode, NodeType, Technology, Feature, Insight } from "../types";

export interface EnrichInput {
  projectName: string;
  // Free-text project description; used only as a language/context hint for the
  // model (so it writes node names/purpose/usage in the project's own language).
  projectDescription?: string;
  nodes: IntelNode[];
  technologies: Technology[];
  features: Feature[];
  insights: Insight[];
  userId: string;
}

export interface EnrichResult {
  nodes: IntelNode[];
  features: Feature[];
  insights: Insight[];
  aiUsed: boolean;
}

// Node types worth describing in human language. Leaf files / config / tests /
// docs / external packages are intentionally excluded: they're collapsed by
// default in the map and keep their (reworded) deterministic descriptions.
const MEANINGFUL_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "feature",
  "module",
  "apiRoute",
  "service",
  "worker",
  "firebaseFunction",
  "dbModel",
  "firestoreCollection",
  "component"
]);

// Order in which nodes are kept when the graph exceeds MAX_ENRICH_NODES, so the
// most architecturally meaningful nodes get human text first.
const ENRICH_PRIORITY: Partial<Record<NodeType, number>> = {
  feature: 0,
  apiRoute: 1,
  firebaseFunction: 2,
  service: 3,
  worker: 4,
  dbModel: 5,
  firestoreCollection: 6,
  module: 7,
  component: 8
};

const MAX_ENRICH_NODES = 300;
const NODE_BATCH = 50;
const NAME_CAP = 80;
const TEXT_CAP = 240;

function clamp(s: string, cap: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}\u2026` : t;
}

// Compact, SECRET-FREE structural context for the project-level pass. We send
// only labels, roles, counts and detected names — never file contents or env
// values.
function buildContext(input: EnrichInput): string {
  const techs = input.technologies.map((t) => t.name).slice(0, 40);
  const features = input.features.map((f) => ({ key: f.key, label: f.label, files: f.files.length }));
  const routes = input.nodes.filter((n) => n.type === "apiRoute").map((n) => n.label).slice(0, 40);
  const models = input.nodes.filter((n) => n.type === "dbModel").map((n) => n.label).slice(0, 30);
  const services = input.nodes.filter((n) => n.type === "service").map((n) => n.label).slice(0, 40);
  const modules = input.nodes.filter((n) => n.type === "module").map((n) => n.label).slice(0, 40);
  return JSON.stringify({ project: input.projectName, technologies: techs, features, modules, routes, services, models });
}

// A single node as presented to the per-node enrichment model. Only structural
// metadata is sent (paths, role, language) — never file contents.
interface NodePromptItem {
  id: string;
  type: NodeType;
  current: string;
  files: string[];
  role?: string;
  language?: string;
}

function toPromptItem(n: IntelNode): NodePromptItem {
  const role = typeof n.metadata?.role === "string" ? (n.metadata.role as string) : undefined;
  const language = typeof n.metadata?.language === "string" ? (n.metadata.language as string) : undefined;
  return {
    id: n.id,
    type: n.type,
    current: n.label,
    files: n.files.slice(0, 5),
    ...(role ? { role } : {}),
    ...(language ? { language } : {})
  };
}

interface EnrichedNode {
  name: string;
  purpose: string;
  usage: string;
}

// Ask the model to humanize one batch of nodes. Returns id -> {name,purpose,
// usage}. Never throws: any failure yields an empty map (callers keep the
// original technical text for those nodes).
async function enrichNodeBatch(
  input: EnrichInput,
  batch: NodePromptItem[]
): Promise<Map<string, EnrichedNode>> {
  const out = new Map<string, EnrichedNode>();
  try {
    const system =
      "You are a principal software architect performing READ-ONLY analysis. " +
      "For each item you are given a code element of a project (a feature, module, API route, service, " +
      "background worker, database model, collection or UI component) with its current technical label and the " +
      "file paths that implement it. NO source code is provided, so everything you write is an INFERENCE from " +
      "structure. For EACH item write, in clear plain language a non-technical product owner can understand: " +
      "(1) name — a short human title (NOT a file name, NOT a path, NOT camelCase); " +
      "(2) purpose — what this part is for / why it exists; " +
      "(3) usage — how and when it is used in the product. " +
      "Reply ONLY with strict JSON: an array of " +
      '{"id": string, "name": string, "purpose": string, "usage": string}. ' +
      `Keep name <= ${NAME_CAP} chars, purpose and usage <= ${TEXT_CAP} chars each. ` +
      "Echo back the exact id you were given. " +
      "Write name, purpose and usage in the SAME natural language as the PROJECT NAME and PROJECT DESCRIPTION; " +
      "if the language is unclear, use English. Do NOT translate file names or code identifiers that appear in paths.";
    const user =
      `PROJECT NAME: ${input.projectName}\n` +
      `PROJECT DESCRIPTION: ${clamp(input.projectDescription || "(none)", 1200)}\n\n` +
      `ELEMENTS:\n${JSON.stringify(batch).slice(0, 9000)}`;

    const raw = await llm(system, user, 0.2, input.userId);
    const parsed = safeJsonArray(raw);
    for (const item of parsed) {
      if (!item || typeof item.id !== "string") continue;
      const name = typeof item.name === "string" ? clamp(item.name, NAME_CAP) : "";
      const purpose = typeof item.purpose === "string" ? clamp(item.purpose, TEXT_CAP) : "";
      const usage = typeof item.usage === "string" ? clamp(item.usage, TEXT_CAP) : "";
      if (!name && !purpose && !usage) continue;
      out.set(item.id, { name, purpose, usage });
    }
  } catch (err) {
    log("warn", "scan_ai_node_batch_failed", { message: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

// Project-level pass: summary -> root node, per-feature purpose -> feature
// nodes, user flows + risks -> "inferred" insights. Mirrors the original
// enrichment so that behaviour is preserved alongside the new per-node pass.
async function enrichProjectLevel(
  input: EnrichInput,
  nodes: IntelNode[],
  features: Feature[],
  insights: Insight[]
): Promise<boolean> {
  try {
    const system =
      "You are a principal software architect performing READ-ONLY analysis. " +
      "Given a project's detected structure (no source code is provided), explain it. " +
      "Everything you produce is an INFERENCE from structure, not confirmed by reading code. " +
      "Reply ONLY with strict JSON matching: " +
      '{"summary": string, "features": [{"key": string, "purpose": string}], "userFlows": [string], "risks": [string]}. ' +
      "Keep summary <= 600 chars, each purpose <= 200 chars, max 6 userFlows, max 6 risks. " +
      "Write all prose in the SAME natural language as the PROJECT NAME / DESCRIPTION; if unclear, use English.";
    const user =
      `PROJECT DESCRIPTION: ${clamp(input.projectDescription || "(none)", 1200)}\n\n` +
      `PROJECT STRUCTURE:\n${buildContext(input).slice(0, 9000)}`;

    const raw = await llm(system, user, 0.2, input.userId);
    const parsed = safeJsonObject(raw);
    if (!parsed) return false;

    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      const root = nodes.find((n) => n.type === "project");
      if (root) {
        root.description = parsed.summary.trim().slice(0, 600);
        root.confidence = "inferred";
        root.metadata = { ...root.metadata, aiSummary: true };
      }
    }

    if (Array.isArray(parsed.features)) {
      for (const item of parsed.features) {
        if (!item || typeof item.key !== "string" || typeof item.purpose !== "string") continue;
        const purpose = item.purpose.trim().slice(0, 200);
        const feat = features.find((f) => f.key === item.key);
        if (feat) feat.description = purpose;
        const node = nodes.find((n) => n.type === "feature" && n.metadata?.key === item.key);
        if (node) {
          node.description = purpose;
          node.confidence = "inferred";
          node.metadata = { ...node.metadata, aiInferred: true };
        }
      }
    }

    let seq = 0;
    const pushNotes = (items: unknown, title: string) => {
      if (!Array.isArray(items)) return;
      for (const it of items.slice(0, 6)) {
        if (typeof it !== "string" || !it.trim()) continue;
        insights.push({
          id: `insight-ai-note-${seq++}`,
          kind: "note",
          severity: "info",
          title,
          detail: it.trim().slice(0, 400),
          confidence: "inferred"
        });
      }
    };
    pushNotes(parsed.userFlows, "User flow (inferred)");
    pushNotes(parsed.risks, "Potential risk (inferred)");

    return true;
  } catch (err) {
    log("warn", "scan_ai_enrich_failed", { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// Optionally enrich the graph with AI-generated, clearly-marked ("inferred")
// human text. NEVER throws into the scan pipeline: on any failure (including no
// API key) it returns the inputs unchanged with aiUsed=false. Two passes:
//   1) project-level summary / feature purposes / flows / risks, and
//   2) per-node human name + purpose + usage for every meaningful node.
export async function enrichWithAI(input: EnrichInput): Promise<EnrichResult> {
  const nodes = input.nodes.map((n) => ({ ...n }));
  const features = input.features.map((f) => ({ ...f }));
  const insights = [...input.insights];

  const projectOk = await enrichProjectLevel(input, nodes, features, insights);

  // Pick the meaningful nodes to humanize, capped + priority-ordered.
  const candidates = nodes
    .filter((n) => MEANINGFUL_TYPES.has(n.type))
    .sort((a, b) => (ENRICH_PRIORITY[a.type] ?? 99) - (ENRICH_PRIORITY[b.type] ?? 99))
    .slice(0, MAX_ENRICH_NODES);

  const enrichedById = new Map<string, EnrichedNode>();
  for (let i = 0; i < candidates.length; i += NODE_BATCH) {
    const batch = candidates.slice(i, i + NODE_BATCH).map(toPromptItem);
    const result = await enrichNodeBatch(input, batch);
    for (const [id, v] of result) enrichedById.set(id, v);
  }

  let nodesEnriched = false;
  for (const n of nodes) {
    const e = enrichedById.get(n.id);
    if (!e) continue;
    // Keep the original technical label/path so the UI can still show a file
    // reference subtly (and never lose the structural info).
    if (typeof n.metadata?.path !== "string") {
      n.metadata = { ...n.metadata, path: n.metadata?.path ?? n.label };
    }
    if (e.name) n.label = e.name;
    if (e.purpose) n.description = e.purpose;
    if (e.usage) n.usage = e.usage;
    n.confidence = "inferred";
    n.metadata = { ...n.metadata, aiInferred: true };
    nodesEnriched = true;
  }

  return { nodes, features, insights, aiUsed: projectOk || nodesEnriched };
}
