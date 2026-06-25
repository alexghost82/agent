"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./ghostMap.css";
import type { Json } from "../api";
import type { ProjectMapData } from "./ProjectMap";
import type { MapNode } from "../types/ghostMap";
import { normalizeToGhostMap } from "./ghostMapAdapter";
import {
  NODE_W,
  computeLayout,
  loadSavedLayout,
  saveLayout,
  clearLayout
} from "./ghostMapLayout";
import { buildMapJson, buildMapMarkdown, downloadText } from "./mapExport";

export interface GhostMapProps {
  data: ProjectMapData;
  projectId: string;
  projectName?: string;
  t?: any;
  loadNodeDetail?: (projectId: string, nodeId: string) => Promise<Json | null>;
}

// Edge anchor point: centre of a node card (matches the reference geometry).
const CX = NODE_W / 2; // 125
const CY = 75; // half of the fixed node height (150)

const MIN_SCALE = 0.2;
const MAX_SCALE = 1.8;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface MergedDetails {
  purpose?: string;
  stack?: string[];
  inputs?: string[];
  outputs?: string[];
  logic?: string[];
  risks?: string[];
  files?: string[];
}

function asArr(v: unknown): string[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
}

export function GhostMap({ data, projectId, projectName, t, loadNodeDetail }: GhostMapProps) {
  const tr = t || {};

  /* ----------------------------- model + layout --------------------------- */
  const model = useMemo(() => normalizeToGhostMap(data), [data]);
  const nodeById = useMemo(() => {
    const m = new Map<string, MapNode>();
    for (const n of model.nodes) m.set(n.id, n);
    return m;
  }, [model.nodes]);

  // Granular "file" nodes are collapsed by default so the map shows the
  // architecture (modules/routes/services/components/...) and not every file.
  // The user reveals them with the toolbar toggle; the layout recompacts.
  const [showFiles, setShowFiles] = useState(false);
  const fileCount = useMemo(() => model.nodes.filter((n) => n.kind === "file").length, [model.nodes]);
  const visibleNodes = useMemo(
    () => (showFiles ? model.nodes : model.nodes.filter((n) => n.kind !== "file")),
    [model.nodes, showFiles]
  );

  const layout = useMemo(() => computeLayout(visibleNodes), [visibleNodes]);

  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  // (Re)seed positions from the deterministic layout, letting any saved manual
  // layout for this project take priority.
  useEffect(() => {
    const merged: Record<string, { x: number; y: number }> = { ...layout.positions };
    const saved = loadSavedLayout(projectId);
    for (const [id, p] of Object.entries(saved)) {
      if (merged[id]) merged[id] = p;
    }
    setPositions(merged);
  }, [layout, projectId]);

  /* ------------------------------- filters/search ------------------------- */
  const [active, setActive] = useState<Set<string>>(() => new Set(model.layers.map((l) => l.id)));
  const [query, setQuery] = useState("");

  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    const out = new Set<string>();
    for (const n of model.nodes) {
      const hay = [n.title, n.desc, n.kind, n.tags.join(" "), JSON.stringify(n.details)]
        .join(" ")
        .toLowerCase();
      if (hay.includes(q)) out.add(n.id);
    }
    return out;
  }, [query, model.nodes]);

  const toggleLayer = useCallback((id: string) => {
    setActive((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ------------------------------- viewport ------------------------------- */
  const vpRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.6);
  const [tx, setTx] = useState(40);
  const [ty, setTy] = useState(20);
  const view = useRef({ scale, tx, ty });
  useEffect(() => {
    view.current = { scale, tx, ty };
  }, [scale, tx, ty]);

  const fit = useCallback(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const w = layout.width + 80;
    const h = layout.height + 80;
    const s = clamp(Math.min(vp.clientWidth / w, vp.clientHeight / h), MIN_SCALE, MAX_SCALE);
    setScale(s);
    setTx(20);
    setTy(20);
  }, [layout.width, layout.height]);

  const resetView = useCallback(() => {
    setScale(0.6);
    setTx(40);
    setTy(20);
  }, []);

  // Auto-fit when the model first lays out.
  useEffect(() => {
    const id = setTimeout(fit, 60);
    return () => clearTimeout(id);
  }, [fit]);

  // Non-passive wheel zoom (React's onWheel is passive and cannot preventDefault).
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      const { scale: old, tx: ctx, ty: cty } = view.current;
      const next = clamp(old * (e.deltaY < 0 ? 1.08 : 0.92), MIN_SCALE, MAX_SCALE);
      setScale(next);
      setTx(ox - (ox - ctx) * (next / old));
      setTy(oy - (oy - cty) * (next / old));
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  /* ------------------------------- panning -------------------------------- */
  const panRef = useRef<{ sx: number; sy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const onVpPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".gm-node") || target.closest("button")) return;
      panRef.current = { sx: e.clientX - view.current.tx, sy: e.clientY - view.current.ty };
      setPanning(true);
      vpRef.current?.setPointerCapture(e.pointerId);
    },
    []
  );
  const onVpPointerMove = useCallback((e: React.PointerEvent) => {
    if (!panRef.current) return;
    setTx(e.clientX - panRef.current.sx);
    setTy(e.clientY - panRef.current.sy);
  }, []);
  const onVpPointerUp = useCallback(() => {
    panRef.current = null;
    setPanning(false);
  }, []);

  /* ----------------------------- node dragging ---------------------------- */
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if ((e.target as HTMLElement).closest(".gm-read")) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = positionsRef.current[id] || { x: 0, y: 0 };
      dragRef.current = { id, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
      setDraggingId(id);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    []
  );
  const onNodePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / view.current.scale;
    const dy = (e.clientY - d.startY) / view.current.scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    setPositions((p) => ({
      ...p,
      [d.id]: { x: Math.max(0, Math.round(d.origX + dx)), y: Math.max(0, Math.round(d.origY + dy)) }
    }));
  }, []);
  const onNodePointerUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingId(null);
    saveLayout(projectId, positionsRef.current);
  }, [projectId]);

  const resetLayout = useCallback(() => {
    clearLayout(projectId);
    setPositions({ ...layout.positions });
    setTimeout(fit, 30);
  }, [projectId, layout.positions, fit]);

  /* ------------------------------ read more modal ------------------------- */
  const [modalId, setModalId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Json | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!modalId || !loadNodeDetail) {
      setDetail(null);
      return;
    }
    // Synthetic risk nodes have no backend detail document.
    if (modalId.startsWith("risk:")) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    loadNodeDetail(projectId, modalId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modalId, projectId, loadNodeDetail]);

  useEffect(() => {
    if (!modalId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalId]);

  const modalNode = modalId ? nodeById.get(modalId) : null;
  const merged: MergedDetails = useMemo(() => {
    const base = modalNode?.details || {};
    const dd = (detail?.details as Record<string, unknown> | undefined) || {};
    const remoteRisks = Array.isArray(detail?.risks)
      ? (detail!.risks as Array<{ title?: string; detail?: string }>).map((r) =>
          [r.title, r.detail].filter(Boolean).join(" — ")
        )
      : [];
    const logicRemote = typeof dd.logic === "string" ? [dd.logic as string] : asArr(dd.logic);
    return {
      purpose: (dd.purpose as string) || base.purpose || (detail?.description as string) || modalNode?.desc || undefined,
      stack: asArr(dd.stack).length ? asArr(dd.stack) : base.stack,
      inputs: asArr(dd.inputs).length ? asArr(dd.inputs) : base.inputs,
      outputs: asArr(dd.outputs).length ? asArr(dd.outputs) : base.outputs,
      logic: logicRemote.length ? logicRemote : base.logic,
      risks: [...(base.risks || []), ...remoteRisks].filter(Boolean),
      files: asArr(detail?.files).length ? asArr(detail?.files) : base.files
    };
  }, [modalNode, detail]);

  /* ------------------------------ right-panel stack ----------------------- */
  const stackRows = useMemo(() => {
    const byCat = new Map<string, string[]>();
    for (const tech of data.technologies || []) {
      const cat = tech.category || "other";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(tech.version ? `${tech.name} ${tech.version}` : tech.name);
    }
    return Array.from(byCat.entries()).map(([cat, names]) => ({ cat, names: names.join(", ") }));
  }, [data.technologies]);

  /* --------------------------------- export ------------------------------- */
  const slug = (projectName || "project").toLowerCase().replace(/\s+/g, "-");
  const exportJson = () => downloadText(`${slug}-map.json`, buildMapJson(data), "application/json");
  const exportMarkdown = () => downloadText(`${slug}-map.md`, buildMapMarkdown(data, projectName), "text/markdown");

  /* --------------------------------- render ------------------------------- */
  const layerLabel = (id: string) => model.layers.find((l) => l.id === id)?.label || id;

  return (
    <div className="ghost-map">
      {/* header */}
      <div className="gm-header">
        <div className="gm-brand">
          <b>{projectName || "Project Map"}</b>
          <span>{tr.intelMapTitle || "Interactive technical & logic map"}</span>
        </div>
        <input
          className="gm-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr.intelSearchPlaceholder || "Search: api, auth, vector\u2026"}
          aria-label={tr.intelSearchPlaceholder || "Search the map"}
        />
        <div className="gm-toolbar">
          {model.layers.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`gm-chip ${active.has(l.id) ? "active" : ""}`}
              data-layer={l.id}
              onClick={() => toggleLayer(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <button type="button" className="gm-btn" onClick={fit}>
          {tr.intelFit || "Fit"}
        </button>
        <button type="button" className="gm-btn" onClick={resetView}>
          {tr.intelResetView || "Reset view"}
        </button>
        <button type="button" className="gm-btn" onClick={resetLayout}>
          {tr.intelResetLayout || "Reset layout"}
        </button>
        {fileCount > 0 ? (
          <button
            type="button"
            className={`gm-btn ${showFiles ? "on" : ""}`}
            onClick={() => setShowFiles((v) => !v)}
            aria-pressed={showFiles}
          >
            {(tr.intelFiles || "Files")} ({fileCount})
          </button>
        ) : null}
        <button type="button" className="gm-btn" onClick={exportJson}>
          {tr.intelExportJson || "Export JSON"}
        </button>
        <button type="button" className="gm-btn" onClick={exportMarkdown}>
          {tr.intelExportMd || "Export Markdown"}
        </button>
      </div>

      <div className="gm-app">
        {/* left aside */}
        <aside className="gm-aside">
          <h2 className="gm-h">{tr.intelHelpTitle || "How to read the map"}</h2>
          <p className="gm-small">
            {tr.intelHelpBody ||
              "Each card is a working part of the system. Arrows show how data flows between parts. Click Read more to open the full node description: stack, inputs/outputs, logic, risks and files. Drag nodes to rearrange them — connections re-route and the layout is saved in your browser."}
          </p>
          <h3 className="gm-h">{tr.intelLayersTitle || "Layer legend"}</h3>
          <div className="gm-legend">
            {model.layers.map((l) => (
              <div key={l.id}>
                <span className="gm-dot" style={{ background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        </aside>

        {/* center canvas */}
        <div
          className={`gm-viewport ${panning ? "panning" : ""}`}
          ref={vpRef}
          onPointerDown={onVpPointerDown}
          onPointerMove={onVpPointerMove}
          onPointerUp={onVpPointerUp}
          onPointerCancel={onVpPointerUp}
        >
          {model.nodes.length === 0 ? (
            <div className="gm-empty">{tr.intelEmptyMap || "No map nodes for this scan yet."}</div>
          ) : null}
          <div
            className="gm-canvas"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              width: layout.width,
              height: layout.height
            }}
          >
            {/* group boxes */}
            {layout.groups
              .filter((g) => active.has(g.id.replace(/^group:/, "")))
              .map((g) => (
                <div
                  key={g.id}
                  className="gm-group"
                  style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
                >
                  <div className="gm-group-title">{g.title}</div>
                </div>
              ))}

            {/* edges */}
            <svg className="gm-edges" width={layout.width} height={layout.height}>
              <defs>
                <marker
                  id={`gm-arrow-${projectId}`}
                  markerWidth="10"
                  markerHeight="10"
                  refX="8"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L0,6 L9,3 z" fill="rgba(148,163,184,.75)" />
                </marker>
              </defs>
              {model.edges.map((e, i) => {
                const a = positions[e.from];
                const b = positions[e.to];
                if (!a || !b) return null;
                const x1 = a.x + CX;
                const y1 = a.y + CY;
                const x2 = b.x + CX;
                const y2 = b.y + CY;
                const dx = Math.max(80, Math.abs(x2 - x1) / 2);
                return (
                  <path
                    key={`${e.from}-${e.to}-${i}`}
                    className={`gm-edge ${e.type && e.type !== "default" ? e.type : ""}`}
                    markerEnd={`url(#gm-arrow-${projectId})`}
                    d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                  />
                );
              })}
            </svg>

            {/* nodes */}
            {visibleNodes.map((n) => {
              const pos = positions[n.id];
              if (!pos) return null;
              const dim = !active.has(n.layer);
              const focus = matchIds.has(n.id);
              const cls = [
                "gm-node",
                `layer-${n.layer}`,
                draggingId === n.id ? "dragging" : "",
                dim ? "dim" : "",
                focus ? "focus" : ""
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  key={n.id}
                  className={cls}
                  data-layer={n.layer}
                  style={{ left: pos.x, top: pos.y }}
                  onPointerDown={(e) => onNodePointerDown(e, n.id)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onPointerCancel={onNodePointerUp}
                >
                  <div className="gm-top">
                    <div className="gm-title">{n.title}</div>
                    <div className="gm-kind">{n.kind}</div>
                  </div>
                  {n.desc ? <div className="gm-desc">{n.desc}</div> : null}
                  {n.tags.length ? (
                    <div className="gm-tags">
                      {n.tags.map((tg, i) => (
                        <span key={`${tg}-${i}`} className="gm-tag">
                          {tg}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <button type="button" className="gm-read" onClick={() => setModalId(n.id)}>
                    {tr.intelReadMore || "Read more"}
                  </button>
                </div>
              );
            })}
          </div>

          {/* minimap / stats */}
          <div className="gm-minimap">
            <div className="gm-stat">
              <span>{tr.intelZoom || "Zoom"}</span>
              <b>{Math.round(scale * 100)}%</b>
            </div>
            <div className="gm-stat">
              <span>{tr.intelNodes || "Nodes"}</span>
              <b>
                {visibleNodes.length}
                {visibleNodes.length !== model.nodes.length ? ` / ${model.nodes.length}` : ""}
              </b>
            </div>
          </div>
        </div>

        {/* right panel */}
        <section className="gm-right">
          <h2 className="gm-h">{tr.intelStackTitle || "Technical stack"}</h2>
          {stackRows.length ? (
            <table className="gm-stack-table">
              <tbody>
                {stackRows.map((r) => (
                  <tr key={r.cat}>
                    <td>{r.cat}</td>
                    <td>{r.names}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="gm-small">{tr.intelNoTech || "No technologies detected."}</p>
          )}

          {data.summary ? (
            <>
              <h3 className="gm-h">{tr.intelSummaryTitle || "Summary"}</h3>
              <p className="gm-small">{String(data.summary)}</p>
            </>
          ) : null}

          {data.risks?.length ? (
            <>
              <h3 className="gm-h">
                {tr.intelRisks || "Risks"} ({data.risks.length})
              </h3>
              <div className="gm-legend">
                {data.risks.slice(0, 12).map((r, i) => (
                  <div key={r.id || i}>
                    <span className="gm-dot" style={{ background: "#fca5a5" }} />
                    {r.title}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </div>

      {/* read more modal */}
      <div className={`gm-modal ${modalId ? "open" : ""}`} onClick={() => setModalId(null)}>
        {modalNode ? (
          <div className="gm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="gm-dialog-head">
              <div>
                <b>{modalNode.title}</b>
                <div className="gm-small">
                  {layerLabel(modalNode.layer)} · {modalNode.kind}
                </div>
              </div>
              <button type="button" className="gm-close" onClick={() => setModalId(null)}>
                {tr.close || "Close"}
              </button>
            </div>
            <div className="gm-body">
              {detailLoading ? <p className="gm-small">{tr.loading || "Loading\u2026"}</p> : null}
              <div className="gm-grid2">
                <div className="gm-card">
                  <h4>{tr.intelPurpose || "Purpose"}</h4>
                  <div className="gm-flow">{merged.purpose || tr.intelNodeMissing || "No description."}</div>
                </div>
                {merged.stack?.length ? (
                  <div className="gm-card">
                    <h4>{tr.intelStack || "Stack"}</h4>
                    <ul>
                      {merged.stack.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {merged.inputs?.length ? (
                  <div className="gm-card">
                    <h4>{tr.intelInputs || "Inputs"}</h4>
                    <ul>
                      {merged.inputs.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {merged.outputs?.length ? (
                  <div className="gm-card">
                    <h4>{tr.intelOutputs || "Outputs"}</h4>
                    <ul>
                      {merged.outputs.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {merged.logic?.length ? (
                  <div className="gm-card">
                    <h4>{tr.intelLogic || "Logic"}</h4>
                    <ul>
                      {merged.logic.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {merged.risks?.length ? (
                  <div className="gm-card">
                    <h4>{tr.intelRisks || "Risks / what to check"}</h4>
                    <ul>
                      {merged.risks.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {merged.files?.length ? (
                  <div className="gm-card">
                    <h4>{tr.intelFiles || "Files"}</h4>
                    <ul>
                      {merged.files.slice(0, 40).map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {Array.isArray(detail?.related) && (detail!.related as unknown[]).length ? (
                  <div className="gm-card">
                    <h4>{tr.intelConnections || "Connections"}</h4>
                    <ul>
                      {(detail!.related as Array<{ label?: string; edgeType?: string; direction?: string }>)
                        .slice(0, 30)
                        .map((r, i) => (
                          <li key={i}>
                            {r.direction === "out" ? "\u2192 " : "\u2190 "}
                            {(r.edgeType || "").replace(/_/g, " ")} {r.label || ""}
                          </li>
                        ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default GhostMap;
