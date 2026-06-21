import { z } from "zod";
import type { DesignMapEdge, DesignMapNode, DesignMapPatch } from "./types";

// Upper bounds guard against storage bloat, oversized LLM token spend and
// abuse/DoS. Generous but finite — mirrors the bounds used by FlowMapSchema.
const ID_MAX = 256;
const LABEL_MAX = 200;
const DESC_MAX = 5000;
// Match the existing FlowMapSchema cap of 500 items per array.
const MAP_ITEMS_MAX = 500;

export const NodeTypeEnum = z.enum([
  "project",
  "design_section",
  "feature",
  "module",
  "screen",
  "component",
  "api_route",
  "database",
  "flow",
  "skill",
  "podskill",
  "decision",
  "risk",
  "note"
]);

export const EdgeTypeEnum = z.enum([
  "depends_on",
  "uses",
  "contains",
  "triggers",
  "produces",
  "blocks",
  "implements",
  "improves",
  "related_to"
]);

export const ConfidenceEnum = z.enum(["high", "medium", "low", "manual"]);

export const DesignMapNodeSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  type: NodeTypeEnum,
  label: z.string().min(1).max(LABEL_MAX),
  description: z.string().max(DESC_MAX).optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.string(), z.unknown()).optional(),
  skillId: z.string().min(1).max(ID_MAX).optional(),
  podskillId: z.string().min(1).max(ID_MAX).optional(),
  confidence: ConfidenceEnum.optional()
});

export const DesignMapEdgeSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  source: z.string().min(1).max(ID_MAX),
  target: z.string().min(1).max(ID_MAX),
  type: EdgeTypeEnum,
  label: z.string().max(LABEL_MAX).optional(),
  data: z.record(z.string(), z.unknown()).optional()
});

// Full payload: a complete set of nodes + edges (used by save).
export const DesignMapPayloadSchema = z.object({
  nodes: z.array(DesignMapNodeSchema).max(MAP_ITEMS_MAX),
  edges: z.array(DesignMapEdgeSchema).max(MAP_ITEMS_MAX)
});

// Patch payload: both arrays optional (used by partial updates).
export const DesignMapPatchSchema = z.object({
  nodes: z.array(DesignMapNodeSchema).max(MAP_ITEMS_MAX).optional(),
  edges: z.array(DesignMapEdgeSchema).max(MAP_ITEMS_MAX).optional()
});

export type DesignMapPayload = {
  nodes: DesignMapNode[];
  edges: DesignMapEdge[];
};

// Helpers throw ZodError on invalid input; the route layer translates that into
// a 400 response.
export function parseDesignMapPayload(input: unknown): DesignMapPayload {
  return DesignMapPayloadSchema.parse(input) as DesignMapPayload;
}

export function parseDesignMapPatch(input: unknown): DesignMapPatch {
  return DesignMapPatchSchema.parse(input) as DesignMapPatch;
}
