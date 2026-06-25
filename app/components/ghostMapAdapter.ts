// Ghost Map adapter — normalize the live scan payload (ProjectMapData) into the
// reference-style render model (GhostMapModel).
//
// The scan speaks in `NodeType` (component/apiRoute/service/dbModel/...) and a
// set of view `layers` (overview/architecture/dataFlow/...). The reference map
// instead colours nodes by one of nine product categories shown as filter
// chips. This module performs that mapping, synthesizes dedicated risk nodes
// from the scan's risks/insights, and tolerates partial / legacy payloads.

import type { ProjectMapData } from "./ProjectMap";
import type {
  GhostLayerId,
  MapEdge,
  MapLayer,
  MapNode,
  MapNodeDetails
} from "../types/ghostMap";

// Reference palette + ordering (see the reference HTML <style> + filters bar).
export const GHOST_LAYERS: MapLayer[] = [
  { id: "frontend", label: "Frontend/UI", color: "#93c5fd" },
  { id: "camera", label: "Camera Logic", color: "#67e8f9" },
  { id: "backend", label: "Backend/API", color: "#86efac" },
  { id: "ai", label: "AI/Vision", color: "#c4b5fd" },
  { id: "data", label: "Data/Memory", color: "#fde68a" },
  { id: "ops", label: "Operations", color: "#fdba74" },
  { id: "ux", label: "UX/UI Journey", color: "#bef264" },
  { id: "admin", label: "Admin/Security", color: "#f9a8d4" },
  { id: "risk", label: "Risks/Audit", color: "#fca5a5" }
];

export const GHOST_LAYER_ORDER: GhostLayerId[] = GHOST_LAYERS.map((l) => l.id as GhostLayerId);

// Coarse NodeType -> category. Refined afterwards by keyword heuristics so e.g.
// an auth service becomes `admin` and an embeddings module becomes `ai`.
const TYPE_TO_LAYER: Record<string, GhostLayerId> = {
  project: "frontend",
  module: "backend",
  feature: "ux",
  component: "frontend",
  apiRoute: "backend",
  service: "backend",
  worker: "backend",
  firebaseFunction: "backend",
  dbModel: "data",
  firestoreCollection: "data",
  file: "data",
  config: "ops",
  externalPackage: "ops",
  test: "ops",
  documentation: "ops"
};

const AI_RE = /\b(ai|llm|gpt|openai|prompt|embedding|vector|chroma|yolo|vision|model|inference)\b/i;
const CAMERA_RE = /\b(camera|stream|webcam|mediastream|video|frame|capture|media)\b/i;
const ADMIN_RE = /\b(auth|security|secret|\.env\b|env|token|jwt|rbac|totp|fernet|credential|password|login)\b/i;

// Refine a base category using the node's label / id / files / tags so the map
// matches the request's fuzzy mapping rules (AI/prompts -> ai, auth/secrets ->
// admin, camera/stream -> camera).
function refineLayer(base: GhostLayerId, haystack: string, hasRisk: boolean): GhostLayerId {
  if (ADMIN_RE.test(haystack)) return hasRisk ? "risk" : "admin";
  if (AI_RE.test(haystack)) return "ai";
  if (CAMERA_RE.test(haystack)) return "camera";
  return base;
}

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
}

// Map a scan edge type to the reference edge style.
function edgeStyle(type: string | undefined): MapEdge["type"] {
  switch (type) {
    case "calls":
    case "exposes":
    case "reads_from_db":
    case "writes_to_db":
      return "hot";
    case "configured_by":
    case "depends_on":
      return "warn";
    default:
      return "default";
  }
}

function toDetails(n: { details?: unknown; files?: unknown; description?: unknown }): MapNodeDetails {
  const d = (n.details || {}) as Record<string, unknown>;
  const logicRaw = d.logic;
  const logic = Array.isArray(logicRaw)
    ? (logicRaw.filter((x) => typeof x === "string") as string[])
    : s(logicRaw)
      ? [s(logicRaw)]
      : undefined;
  return {
    purpose: s(d.purpose) || undefined,
    stack: arr(d.stack).length ? arr(d.stack) : undefined,
    inputs: arr(d.inputs).length ? arr(d.inputs) : undefined,
    outputs: arr(d.outputs).length ? arr(d.outputs) : undefined,
    logic,
    risks: arr(d.risks).length ? arr(d.risks) : undefined,
    files: arr(d.files).length ? arr(d.files) : arr(n.files),
    raw: n.details ?? null
  };
}

export interface NormalizedGhostMap {
  layers: MapLayer[];
  nodes: MapNode[];
  edges: MapEdge[];
}

// Normalize the scan payload. Positions are left at {0,0}; the layout module
// assigns deterministic coordinates (and group boxes) afterwards.
export function normalizeToGhostMap(data: ProjectMapData | null | undefined): NormalizedGhostMap {
  const rawNodes = Array.isArray(data?.nodes) ? data!.nodes : [];
  const rawEdges = Array.isArray(data?.edges) ? data!.edges : [];

  const nodes: MapNode[] = rawNodes.map((n) => {
    const title = s((n as { title?: unknown }).title) || s(n.label) || s(n.id);
    const kind = s((n as { kind?: unknown }).kind) || s(n.type) || "file";
    const files = arr(n.files);
    const tags = arr(n.tags);
    const haystack = [title, s(n.id), kind, tags.join(" "), files.join(" ")].join(" ");
    const base = TYPE_TO_LAYER[s(n.type)] || "data";
    const layer = refineLayer(base, haystack, !!n.hasRisk);
    // Many scan file-nodes have no prose description; fall back to the primary
    // file path (or the kind) so every card still carries useful context.
    const desc = s(n.description) || files[0] || kind;
    return {
      id: s(n.id),
      title,
      kind,
      layer,
      desc,
      tags,
      x: 0,
      y: 0,
      details: toDetails(n)
    };
  });

  const ids = new Set(nodes.map((n) => n.id));

  const edges: MapEdge[] = [];
  for (const e of rawEdges) {
    const from = s(e.source);
    const to = s(e.target);
    if (!ids.has(from) || !ids.has(to)) {
      // edge pointing to a missing node — skip, never crash.
      console.warn(`[GhostMap] skipping edge ${from || "?"} -> ${to || "?"}: missing node`);
      continue;
    }
    edges.push({ from, to, type: edgeStyle(e.type) });
  }

  // Synthesize risk/audit nodes from risks (preferred) or insights, recreating
  // the reference's "Audit:" nodes from real scan findings.
  const findings = (Array.isArray(data?.risks) && data!.risks!.length
    ? data!.risks!
    : Array.isArray(data?.insights)
      ? data!.insights!
      : []) as Array<{
    id?: string;
    title?: string;
    detail?: string;
    severity?: string;
    nodeIds?: string[];
    files?: string[];
  }>;

  findings.forEach((r, i) => {
    const rid = `risk:${s(r.id) || i}`;
    if (ids.has(rid)) return;
    const title = s(r.title) || "Risk";
    const detail = s(r.detail);
    nodes.push({
      id: rid,
      title,
      kind: "risk",
      layer: "risk",
      desc: detail,
      tags: [s(r.severity) || "risk"].filter(Boolean),
      x: 0,
      y: 0,
      details: {
        purpose: detail || undefined,
        risks: detail ? [detail] : undefined,
        files: arr(r.files).length ? arr(r.files) : undefined,
        raw: r
      }
    });
    ids.add(rid);
    for (const target of arr(r.nodeIds)) {
      if (ids.has(target)) edges.push({ from: target, to: rid, type: "risk" });
    }
  });

  return { layers: GHOST_LAYERS, nodes, edges };
}

export default normalizeToGhostMap;
