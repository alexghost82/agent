// Ghost Map layout — deterministic, category-clustered placement.
//
// The live scan ships React-Flow columnar coordinates tuned for small nodes, so
// instead of reusing them we lay the 250px reference cards out in stable
// clusters (one per colour category, ordered by node id). The same scan always
// yields the same layout; a user's manual drag is persisted to localStorage and
// takes priority on next open.

import { GHOST_LAYERS, GHOST_LAYER_ORDER } from "./ghostMapAdapter";
import type { GhostLayerId, MapGroup, MapNode } from "../types/ghostMap";

export const NODE_W = 250;
export const NODE_H = 150;

const GAP = 30; // gap between nodes inside a cluster
const PAD = 24; // group inner padding
const TITLE_H = 30; // space reserved for the group title
const GROUP_GAP = 56; // gap between group boxes
const START_X = 30;
const START_Y = 30;
const CANVAS_TARGET_W = 2200;

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  groups: MapGroup[];
  width: number;
  height: number;
}

function clusterCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 1;
  if (count <= 9) return 2;
  if (count <= 16) return 3;
  return 4;
}

const LAYER_LABEL: Record<string, string> = Object.fromEntries(
  GHOST_LAYERS.map((l) => [l.id, l.label])
);

// Deterministic positions + one group box per non-empty category.
export function computeLayout(nodes: MapNode[]): LayoutResult {
  const byLayer = new Map<GhostLayerId, MapNode[]>();
  for (const n of nodes) {
    const layer = n.layer as GhostLayerId;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(n);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const groups: MapGroup[] = [];

  let cursorX = START_X;
  let cursorY = START_Y;
  let rowMaxH = 0;
  let maxRight = START_X;

  for (const layer of GHOST_LAYER_ORDER) {
    const members = byLayer.get(layer);
    if (!members || members.length === 0) continue;
    const ordered = [...members].sort((a, b) => a.id.localeCompare(b.id));

    const cols = clusterCols(ordered.length);
    const rows = Math.ceil(ordered.length / cols);
    const innerW = cols * NODE_W + (cols - 1) * GAP;
    const innerH = rows * NODE_H + (rows - 1) * GAP;
    const groupW = innerW + PAD * 2;
    const groupH = innerH + PAD * 2 + TITLE_H;

    // Wrap to a new row of groups when we would overflow the target width.
    if (cursorX > START_X && cursorX + groupW > CANVAS_TARGET_W) {
      cursorX = START_X;
      cursorY += rowMaxH + GROUP_GAP;
      rowMaxH = 0;
    }

    groups.push({
      id: `group:${layer}`,
      title: LAYER_LABEL[layer] || layer,
      x: cursorX,
      y: cursorY,
      w: groupW,
      h: groupH
    });

    const baseX = cursorX + PAD;
    const baseY = cursorY + TITLE_H + PAD;
    ordered.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions[n.id] = {
        x: baseX + col * (NODE_W + GAP),
        y: baseY + row * (NODE_H + GAP)
      };
    });

    cursorX += groupW + GROUP_GAP;
    rowMaxH = Math.max(rowMaxH, groupH);
    maxRight = Math.max(maxRight, groups[groups.length - 1].x + groupW);
  }

  const width = Math.max(CANVAS_TARGET_W, maxRight + START_X);
  const height = cursorY + rowMaxH + START_Y;
  return { positions, groups, width, height };
}

/* --------------------------- localStorage layout -------------------------- */

const KEY_PREFIX = "ghost.map.layout:";

export function layoutKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function loadSavedLayout(projectId: string): Record<string, { x: number; y: number }> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(layoutKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    const out: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(parsed)) {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[id] = { x: p.x, y: p.y };
    }
    return out;
  } catch (e) {
    console.warn("[GhostMap] layout restore failed", e);
    return {};
  }
}

export function saveLayout(projectId: string, positions: Record<string, { x: number; y: number }>): void {
  if (typeof localStorage === "undefined") return;
  try {
    const rounded: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(positions)) {
      rounded[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    localStorage.setItem(layoutKey(projectId), JSON.stringify(rounded));
  } catch (e) {
    console.warn("[GhostMap] layout save failed", e);
  }
}

export function clearLayout(projectId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(layoutKey(projectId));
  } catch (e) {
    console.warn("[GhostMap] layout clear failed", e);
  }
}
