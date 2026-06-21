import { Router, Response } from "express";
import { db } from "../firebase";
import { AuthedRequest } from "../auth";
import { sendError, notFound, badRequest } from "../errors";
import { saveDesignMap, patchDesignMap, ensureInitialDesignMap } from "../designMap/store";
import { parseDesignMapPayload, parseDesignMapPatch } from "../designMap/validators";
import type { DesignMapNode, DesignMapEdge } from "../designMap/types";

export const designMapRouter = Router();

// Mirror of the ownership pattern used by the other project routes: a project is
// only reachable by its owner. Returns the doc (for reading project fields) or
// null when missing / not owned. The route translates null into a 404 so we
// never leak the existence of another user's project.
async function ownedProject(userId: string, projectId: string) {
  const doc = await db.collection("projects").doc(projectId).get();
  if (!doc.exists || doc.data()?.userId !== userId) return null;
  return doc;
}

// Shape the project document into the lightweight seed input expected by
// ensureInitialDesignMap (the domain module owns how this becomes a first map).
// Optional fields are coerced to `string | undefined` (never null) so the value
// is structurally compatible with the store's seed type.
function projectSeed(id: string, data: FirebaseFirestore.DocumentData | undefined) {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return {
    id,
    name: str(data?.name),
    description: str(data?.description),
    stack: str(data?.stack),
    summary: str(data?.summary),
    repoUrl: str(data?.repoUrl),
    skillIds: Array.isArray(data?.skillIds) ? (data?.skillIds as string[]) : []
  };
}

// Pick the node new skill/podskill nodes should hang off of: prefer the
// dedicated design_section anchor, fall back to the root project node.
function anchorNode(nodes: DesignMapNode[]): DesignMapNode | undefined {
  return nodes.find((n) => n.type === "design_section") ?? nodes.find((n) => n.type === "project");
}

// Deterministic-ish placement for manually added nodes so they don't all stack
// on top of each other when the client doesn't supply a position.
function autoPosition(nodes: DesignMapNode[]): { x: number; y: number } {
  const n = nodes.length;
  return { x: 240 + (n % 6) * 220, y: 320 + Math.floor(n / 6) * 160 };
}

function isPosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const p = value as { x?: unknown; y?: unknown };
  return typeof p.x === "number" && typeof p.y === "number";
}

// Read + ownership-verify a skill the caller claims to own. Returns the skill
// data or null (missing or owned by someone else) so the route can 404.
async function ownedSkill(userId: string, skillId: string) {
  const doc = await db.collection("agent_skills").doc(skillId).get();
  if (!doc.exists || doc.data()?.userId !== userId) return null;
  return doc;
}

// 1) GET — load (and seed on first open) the design map for a project.
designMapRouter.get("/projects/:id/design-map", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const project = await ownedProject(req.userId!, projectId);
    if (!project) {
      sendError(req, res, notFound());
      return;
    }
    const map = await ensureInitialDesignMap(req.userId!, projectSeed(projectId, project.data()));
    res.json({ map });
  } catch (err) {
    sendError(req, res, err);
  }
});

// 2) POST — replace the whole map (full save from the editor).
designMapRouter.post("/projects/:id/design-map", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const project = await ownedProject(req.userId!, projectId);
    if (!project) {
      sendError(req, res, notFound());
      return;
    }
    const { nodes, edges } = parseDesignMapPayload(req.body);
    const map = await saveDesignMap(req.userId!, projectId, { nodes, edges });
    res.json({ status: "saved", map });
  } catch (err) {
    sendError(req, res, err);
  }
});

// 3) PATCH — partial update (only provided arrays are replaced).
designMapRouter.patch("/projects/:id/design-map", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const project = await ownedProject(req.userId!, projectId);
    if (!project) {
      sendError(req, res, notFound());
      return;
    }
    const patch = parseDesignMapPatch(req.body);
    const map = await patchDesignMap(req.userId!, projectId, patch);
    if (!map) {
      sendError(req, res, notFound());
      return;
    }
    res.json({ status: "saved", map });
  } catch (err) {
    sendError(req, res, err);
  }
});

// 4) POST — add a single owned skill as a node (idempotent on the node id).
designMapRouter.post("/projects/:id/design-map/add-skill", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const body = (req.body ?? {}) as { skillId?: unknown; position?: unknown };
    const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
    if (!skillId) {
      sendError(req, res, badRequest("skillId is required"));
      return;
    }

    const project = await ownedProject(req.userId!, projectId);
    if (!project) {
      sendError(req, res, notFound());
      return;
    }
    const skillDoc = await ownedSkill(req.userId!, skillId);
    if (!skillDoc) {
      sendError(req, res, notFound());
      return;
    }
    const skill = skillDoc.data() ?? {};

    const map = await ensureInitialDesignMap(req.userId!, projectSeed(projectId, project.data()));
    const nodes: DesignMapNode[] = [...map.nodes];
    const edges: DesignMapEdge[] = [...map.edges];

    const nodeId = `skill-${skillId}`;
    const label = String(skill.skillName ?? "Skill");
    const description = skill.description != null ? String(skill.description) : undefined;
    const position = isPosition(body.position) ? body.position : autoPosition(nodes);

    const existing = nodes.find((n) => n.id === nodeId);
    if (existing) {
      // Keep the node unique; refresh its label/description from the source skill.
      existing.label = label;
      if (description !== undefined) existing.description = description;
    } else {
      nodes.push({
        id: nodeId,
        type: "skill",
        label,
        description,
        position,
        skillId,
        confidence: "manual"
      });
    }

    const anchor = anchorNode(nodes);
    if (anchor && anchor.id !== nodeId) {
      const edgeId = `e-${anchor.id}-${nodeId}`;
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({ id: edgeId, source: anchor.id, target: nodeId, type: "uses" });
      }
    }

    const saved = await saveDesignMap(req.userId!, projectId, { nodes, edges });
    res.json({ status: "added", map: saved });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Candidate fields that may hold a skill's podskills. Podskills are not their own
// collection, so we probe the skill document for the first array we recognise.
const PODSKILL_FIELDS = ["podskills", "subskills", "children", "steps", "items"] as const;

function findPodskillArray(skill: FirebaseFirestore.DocumentData): unknown[] | null {
  for (const field of PODSKILL_FIELDS) {
    const value = skill[field];
    if (Array.isArray(value)) return value;
  }
  return null;
}

// Match a podskill within the array by explicit id, by primitive equality, or by
// its index (stringified). Returns the matched item + a human label, or null.
function matchPodskill(items: unknown[], podskillId: string): { item: unknown; label: string } | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let matches = false;
    if (typeof item === "object" && item !== null) {
      const id = (item as { id?: unknown }).id;
      if (id != null && String(id) === podskillId) matches = true;
    } else if (String(item) === podskillId) {
      matches = true;
    }
    if (!matches && String(i) === podskillId) matches = true;
    if (!matches) continue;

    let label = String(item);
    if (typeof item === "object" && item !== null) {
      const obj = item as { name?: unknown; label?: unknown; title?: unknown };
      label = String(obj.name ?? obj.label ?? obj.title ?? podskillId);
    }
    return { item, label };
  }
  return null;
}

// 5) POST — add a podskill (a child of one of the user's skills) as a node.
designMapRouter.post("/projects/:id/design-map/add-podskill", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const body = (req.body ?? {}) as { skillId?: unknown; podskillId?: unknown; position?: unknown };
    const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
    const podskillId = typeof body.podskillId === "string" ? body.podskillId.trim() : "";
    if (!skillId) {
      sendError(req, res, badRequest("skillId is required"));
      return;
    }
    if (!podskillId) {
      sendError(req, res, badRequest("podskillId is required"));
      return;
    }

    const project = await ownedProject(req.userId!, projectId);
    if (!project) {
      sendError(req, res, notFound());
      return;
    }
    const skillDoc = await ownedSkill(req.userId!, skillId);
    if (!skillDoc) {
      sendError(req, res, notFound());
      return;
    }
    const skill = skillDoc.data() ?? {};

    const podskills = findPodskillArray(skill);
    if (!podskills) {
      sendError(req, res, badRequest("skill has no podskills"));
      return;
    }
    const matched = matchPodskill(podskills, podskillId);
    if (!matched) {
      sendError(req, res, notFound());
      return;
    }

    const map = await ensureInitialDesignMap(req.userId!, projectSeed(projectId, project.data()));
    const nodes: DesignMapNode[] = [...map.nodes];
    const edges: DesignMapEdge[] = [...map.edges];

    const nodeId = `podskill-${skillId}-${podskillId}`;
    const position = isPosition(body.position) ? body.position : autoPosition(nodes);

    const existing = nodes.find((n) => n.id === nodeId);
    if (existing) {
      existing.label = matched.label;
    } else {
      nodes.push({
        id: nodeId,
        type: "podskill",
        label: matched.label,
        position,
        skillId,
        podskillId,
        confidence: "manual"
      });
    }

    // Prefer the parent skill node; fall back to the design anchor if the skill
    // hasn't been added to the map yet.
    const parentSkillId = `skill-${skillId}`;
    const parent = nodes.find((n) => n.id === parentSkillId) ?? anchorNode(nodes);
    if (parent && parent.id !== nodeId) {
      const edgeId = `e-${parent.id}-${nodeId}`;
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({ id: edgeId, source: parent.id, target: nodeId, type: "contains" });
      }
    }

    const saved = await saveDesignMap(req.userId!, projectId, { nodes, edges });
    res.json({ status: "added", map: saved });
  } catch (err) {
    sendError(req, res, err);
  }
});
