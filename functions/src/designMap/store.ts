import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import type { DesignMap, DesignMapEdge, DesignMapNode } from "./types";
import {
  buildInitialDesignMap,
  buildDesignMapFromScanGraph,
  type InitialMapProject,
  type InitialMapSkill,
  type ScanGraphInput
} from "./initialMap";

const COLLECTION = "design_maps";

function docRef(projectId: string) {
  return db.collection(COLLECTION).doc(projectId);
}

// Stored Firestore shape. createdAt/updatedAt are server timestamps.
interface StoredDesignMap {
  userId: string;
  projectId: string;
  nodes: DesignMapNode[];
  edges: DesignMapEdge[];
  version: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function toDesignMap(data: StoredDesignMap): DesignMap {
  return {
    projectId: data.projectId,
    userId: data.userId,
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
    version: typeof data.version === "number" ? data.version : 0,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

// Reads the map and enforces ownership at the data layer: a doc owned by a
// different user is treated as missing.
export async function getDesignMap(userId: string, projectId: string): Promise<DesignMap | null> {
  const snap = await docRef(projectId).get();
  if (!snap.exists) return null;
  const data = snap.data() as StoredDesignMap | undefined;
  if (!data || data.userId !== userId) return null;
  return toDesignMap(data);
}

// Full upsert: replaces nodes/edges wholesale, preserves createdAt, bumps the
// version and stamps updatedAt.
export async function saveDesignMap(
  userId: string,
  projectId: string,
  map: { nodes: DesignMapNode[]; edges: DesignMapEdge[]; version?: number }
): Promise<DesignMap> {
  const ref = docRef(projectId);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() as StoredDesignMap | undefined) : undefined;

  const baseVersion =
    typeof map.version === "number"
      ? map.version
      : typeof existing?.version === "number"
        ? existing.version
        : 0;
  const nextVersion = baseVersion + 1;

  const createdAt = existing?.createdAt ?? serverTime();
  const updatedAt = serverTime();

  const stored: StoredDesignMap = {
    userId,
    projectId,
    nodes: map.nodes,
    edges: map.edges,
    version: nextVersion,
    createdAt,
    updatedAt
  };

  await ref.set(stored, { merge: false });
  await logEvent(userId, "design_map_saved", projectId, {
    version: nextVersion,
    nodes: map.nodes.length,
    edges: map.edges.length
  });

  return toDesignMap(stored);
}

// Partial update: only the provided arrays are replaced. Returns null when the
// doc is missing or not owned by `userId`.
export async function patchDesignMap(
  userId: string,
  projectId: string,
  patch: { nodes?: DesignMapNode[]; edges?: DesignMapEdge[] }
): Promise<DesignMap | null> {
  const ref = docRef(projectId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const existing = snap.data() as StoredDesignMap | undefined;
  if (!existing || existing.userId !== userId) return null;

  const nextVersion = (typeof existing.version === "number" ? existing.version : 0) + 1;
  const updatedAt = serverTime();

  const update: Record<string, unknown> = { version: nextVersion, updatedAt };
  if (patch.nodes !== undefined) update.nodes = patch.nodes;
  if (patch.edges !== undefined) update.edges = patch.edges;

  await ref.update(update);
  await logEvent(userId, "design_map_patched", projectId, {
    version: nextVersion,
    nodes: patch.nodes?.length,
    edges: patch.edges?.length
  });

  return toDesignMap({
    ...existing,
    userId,
    projectId,
    nodes: patch.nodes !== undefined ? patch.nodes : existing.nodes,
    edges: patch.edges !== undefined ? patch.edges : existing.edges,
    version: nextVersion,
    updatedAt
  });
}

// Resolves raw skill ids into enriched skill data, enforcing ownership at the
// data layer (mirrors `ownedSkill` in routes/designMap.ts): a skill owned by a
// different user — or one that doesn't exist — is skipped. Order is preserved so
// the seeded grid layout stays deterministic.
async function resolveOwnedSkills(userId: string, skillIds: string[]): Promise<InitialMapSkill[]> {
  const ids = skillIds.map((id) => String(id)).filter(Boolean);
  const snaps = await Promise.all(
    ids.map((id) => db.collection("agent_skills").doc(id).get())
  );
  const resolved: InitialMapSkill[] = [];
  snaps.forEach((snap, index) => {
    const data = snap.exists ? snap.data() : undefined;
    if (!data || data.userId !== userId) return;
    resolved.push({
      id: ids[index],
      skillName: typeof data.skillName === "string" ? data.skillName : undefined,
      description: typeof data.description === "string" ? data.description : undefined
    });
  });
  return resolved;
}

// Returns the existing owned map, or builds + persists an initial one.
//
// When `loadScanGraph` is supplied it is consulted ONLY on first seed (never
// when a map already exists, so it costs nothing on the common path). If it
// yields a Project Intelligence scan graph, the initial map is derived from that
// rich graph; otherwise we fall back to the thin project-field seed. The loader
// is injected (rather than imported here) to keep this module decoupled from the
// project-intelligence package.
export async function ensureInitialDesignMap(
  userId: string,
  project: InitialMapProject,
  loadScanGraph?: () => Promise<ScanGraphInput | null>
): Promise<DesignMap> {
  const existing = await getDesignMap(userId, project.id);
  if (existing) return existing;

  // Enrich raw skill ids into ownership-checked skills once, so both the
  // scan-graph path and the thin-seed fallback surface real skill names and
  // descriptions on the seeded skill nodes.
  const skills = await resolveOwnedSkills(userId, project.skillIds ?? []);
  const enrichedProject: InitialMapProject = { ...project, skills };

  let built: { nodes: DesignMapNode[]; edges: DesignMapEdge[] } | null = null;
  if (loadScanGraph) {
    const graph = await loadScanGraph();
    if (graph && graph.nodes.length > 0) {
      built = buildDesignMapFromScanGraph(enrichedProject, graph);
    }
  }
  if (!built) built = buildInitialDesignMap(enrichedProject);

  return saveDesignMap(userId, project.id, built);
}
