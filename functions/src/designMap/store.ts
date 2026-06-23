import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import type { DesignMap, DesignMapEdge, DesignMapNode } from "./types";
import { buildInitialDesignMap, type InitialMapProject, type InitialMapSkill } from "./initialMap";

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
export async function ensureInitialDesignMap(
  userId: string,
  project: InitialMapProject
): Promise<DesignMap> {
  const existing = await getDesignMap(userId, project.id);
  if (existing) return existing;

  const skills = await resolveOwnedSkills(userId, project.skillIds ?? []);
  const { nodes, edges } = buildInitialDesignMap({ ...project, skills });
  return saveDesignMap(userId, project.id, { nodes, edges });
}
