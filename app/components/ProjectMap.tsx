"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./projectMapWorkspace.css";
import {
  NODE_TYPES,
  NODE_TYPE_LABEL,
  LAYERS,
  LAYER_LABEL,
  type IntelLayerId,
  type IntelNodeType
} from "./intelTypes";
import { buildMapJson, buildMapMarkdown, downloadText } from "./mapExport";
import type {
  ProjectMapNode,
  ProjectMapEdge,
  ProjectTechnology,
  ProjectFeature,
  ProjectInsight,
  ProjectRisk,
  ProjectDependency,
  ProjectFileIndexItem,
  ProjectMapGroup,
  NodeDetails
} from "../types/projectMap";

interface IntelNodeData {
  label: string;
  ntype: IntelNodeType;
  confidence: string;
  hasRisk: boolean;
  groupParent?: string | null;
  collapsible: boolean;
  collapsed: boolean;
  dim: boolean;
  match: boolean;
  [key: string]: unknown;
}

interface RawNode {
  id: string;
  type: IntelNodeType;
  label: string;
  group?: string | null;
  confidence: string;
  layers: IntelLayerId[];
  position: { x: number; y: number };
  hasRisk?: boolean;
  // Optional richer fields (present in the demo payload / future enriched scans).
  description?: string;
  // Technical file reference shown subtly under the (humanized) title.
  subtitle?: string;
  // Human "how / when this is used" (использование).
  usage?: string;
  tags?: string[];
  files?: string[];
  details?: NodeDetails;
}
interface RawEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  layers: IntelLayerId[];
}

// Backwards-compatible payload shape. The first six fields are the original
// contract (unchanged); the rest are OPTIONAL enrichment served by the updated
// `GET /projects/:id/scan/map` and are tolerated-when-absent so old scans and
// older callers keep working.
export interface ProjectMapData {
  nodes: RawNode[];
  edges: RawEdge[];
  technologies: ProjectTechnology[];
  features: ProjectFeature[];
  insights: ProjectInsight[];
  stats: { files: number; nodes: number; edges: number; risks?: number; technologies?: number };
  summary?: string | null;
  risks?: ProjectRisk[];
  dependencies?: ProjectDependency[];
  fileIndex?: ProjectFileIndexItem[];
  groups?: ProjectMapGroup[];
  scanId?: string;
  status?: string;
  generatedAt?: number;
}

export interface ProjectMapProps {
  data: ProjectMapData;
  t: any;
  onSelectNode: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  // Optional: project name shown in the summary panel header.
  projectName?: string;
  // Optional: when both are provided, ProjectMap renders the "Read more" node
  // detail as an in-canvas drawer itself (instead of the host doing it).
  renderNodeDetail?: (nodeId: string) => React.ReactNode;
}

/* -------------------------------------------------------------------------- */
/* Pure export builders (re-exported from mapExport for backwards compat).     */
/* -------------------------------------------------------------------------- */

export { buildMapJson, buildMapMarkdown };

const t = (v: unknown): string => (typeof v === "string" ? v : "");
const titleOf = (n: RawNode | ProjectMapNode): string =>
  (n as ProjectMapNode).title || n.label || n.id;
const kindOf = (n: RawNode | ProjectMapNode): string =>
  ((n as ProjectMapNode).kind as string) || (n.type as string) || "file";

/* -------------------------------------------------------------------------- */
/* Node renderer                                                              */
/* -------------------------------------------------------------------------- */

function IntelNode({ data, selected }: NodeProps) {
  const d = data as IntelNodeData;
  const cls = [
    "intel-node",
    `type-${d.ntype}`,
    selected ? "selected" : "",
    d.hasRisk ? "risk" : "",
    d.dim ? "dim" : "",
    d.match ? "match" : "",
    d.collapsed ? "collapsed" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} title={d.label}>
      <Handle type="target" position={Position.Left} />
      <span className="intel-node-type">{NODE_TYPE_LABEL[d.ntype] || d.ntype}</span>
      <span className="intel-node-label">{d.label}</span>
      {d.confidence === "inferred" ? <span className="intel-badge inferred">AI</span> : null}
      {d.hasRisk ? <span className="intel-badge risk">!</span> : null}
      {d.collapsible ? <span className="intel-caret">{d.collapsed ? "+" : "\u2212"}</span> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { intel: IntelNode };

const NODE_W = 190;
const NODE_H = 56;

function FlowInner({ data, t: tr, onSelectNode, selectedNodeId, projectName, renderNodeDetail }: ProjectMapProps) {
  const [layer, setLayer] = useState<IntelLayerId>("overview");
  const [enabledTypes, setEnabledTypes] = useState<Set<IntelNodeType>>(new Set(NODE_TYPES));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [helpOpen, setHelpOpen] = useState(true);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const { fitView } = useReactFlow();

  const lbl = (map: Record<string, string> | undefined, key: string, fallback: string) =>
    (map && map[key]) || fallback;

  const nodes = data.nodes || [];
  const edges = data.edges || [];

  const collapsibleIds = useMemo(() => {
    const parents = new Set<string>();
    for (const n of nodes) if (n.group) parents.add(n.group);
    return parents;
  }, [nodes]);

  // Per-node search index: title + kind + description + tags + files + risks.
  const searchIndex = useMemo(() => {
    const riskByNode = new Map<string, string[]>();
    for (const r of data.risks || []) {
      for (const id of r.nodeIds || []) {
        if (!riskByNode.has(id)) riskByNode.set(id, []);
        riskByNode.get(id)!.push(r.title);
      }
    }
    const idx = new Map<string, string>();
    for (const n of nodes) {
      const parts = [
        titleOf(n),
        kindOf(n),
        n.description || "",
        ...(n.tags || []),
        ...(n.files || []),
        ...(riskByNode.get(n.id) || [])
      ];
      idx.set(n.id, parts.join(" \u00b7 ").toLowerCase());
    }
    return idx;
  }, [nodes, data.risks]);

  const q = query.trim().toLowerCase();
  const matchesNode = useCallback(
    (id: string) => q.length > 0 && (searchIndex.get(id) || "").includes(q),
    [q, searchIndex]
  );

  const visibleNodes = useMemo<Node[]>(() => {
    return nodes
      .filter((n) => (n.layers || []).includes(layer))
      .filter((n) => enabledTypes.has(n.type))
      .filter((n) => !(n.group && collapsed.has(n.group)))
      .map((n) => {
        const match = matchesNode(n.id);
        const dim = q.length > 0 && !match;
        const pos = positions[n.id] || n.position;
        return {
          id: n.id,
          type: "intel",
          position: pos,
          initialWidth: NODE_W,
          initialHeight: NODE_H,
          selected: n.id === selectedNodeId,
          data: {
            label: titleOf(n),
            ntype: n.type,
            confidence: n.confidence,
            hasRisk: !!n.hasRisk,
            groupParent: n.group ?? null,
            collapsible: collapsibleIds.has(n.id),
            collapsed: collapsed.has(n.id),
            dim,
            match
          } as IntelNodeData
        } as Node;
      });
  }, [nodes, layer, enabledTypes, collapsed, q, positions, selectedNodeId, collapsibleIds, matchesNode]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo<Edge[]>(() => {
    return edges
      .filter((e) => (e.layers || []).includes(layer))
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        className: `intel-edge type-${e.type}`,
        animated: layer === "dataFlow" || layer === "uiFlow"
      }));
  }, [edges, layer, visibleIds]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPositions((cur) => {
      const next = { ...cur };
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) next[ch.id] = ch.position;
      }
      return next;
    });
  }, []);

  const toggleType = useCallback((type: IntelNodeType) => {
    setEnabledTypes((cur) => {
      const next = new Set(cur);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => onSelectNode(node.id),
    [onSelectNode]
  );
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const d = node.data as IntelNodeData;
    if (!d.collapsible) return;
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  useEffect(() => {
    const id = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60);
    return () => clearTimeout(id);
  }, [layer, fitView]);

  const resetView = useCallback(() => {
    setPositions({});
    setCollapsed(new Set());
    setEnabledTypes(new Set(NODE_TYPES));
    setQuery("");
    setLayer("overview");
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60);
  }, [fitView]);

  const presentTypes = useMemo(() => {
    const s = new Set<IntelNodeType>();
    for (const n of nodes) s.add(n.type);
    return s;
  }, [nodes]);

  const stats = data.stats || { files: 0, nodes: 0, edges: 0 };
  const statItems: { key: string; label: string; value: number }[] = [
    { key: "nodes", label: lbl(tr?.intelStat, "nodes", "Nodes"), value: stats.nodes ?? nodes.length },
    { key: "edges", label: lbl(tr?.intelStat, "edges", "Edges"), value: stats.edges ?? edges.length },
    { key: "files", label: lbl(tr?.intelStat, "files", "Files"), value: stats.files ?? (data.fileIndex?.length || 0) },
    { key: "risks", label: lbl(tr?.intelStat, "risks", "Risks"), value: stats.risks ?? (data.risks?.length || 0) },
    {
      key: "technologies",
      label: lbl(tr?.intelStat, "technologies", "Tech"),
      value: stats.technologies ?? (data.technologies?.length || 0)
    }
  ];

  const exportJson = () =>
    downloadText(`${(projectName || "project").toLowerCase().replace(/\s+/g, "-")}-map.json`, buildMapJson(data), "application/json");
  const exportMarkdown = () =>
    downloadText(`${(projectName || "project").toLowerCase().replace(/\s+/g, "-")}-map.md`, buildMapMarkdown(data, projectName), "text/markdown");

  const legendTypes = NODE_TYPES.filter((tp) => presentTypes.has(tp));

  return (
    <div className="pmw intel-map">
      {/* Header toolbar */}
      <div className="pmw-toolbar intel-toolbar">
        <div className="pmw-toolbar-left">
          <button
            type="button"
            className={`pmw-toggle ${helpOpen ? "on" : ""}`}
            onClick={() => setHelpOpen((v) => !v)}
            aria-pressed={helpOpen}
            title={tr?.intelHelpTitle || "How to read the map"}
          >
            {tr?.intelHelpShort || "Legend"}
          </button>
          <div className="intel-search pmw-search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr?.intelSearchPlaceholder || "Search nodes, files, risks\u2026"}
              aria-label={tr?.intelSearchPlaceholder || "Search the map"}
            />
          </div>
        </div>
        <div className="intel-layers pmw-layers">
          {LAYERS.map((id) => (
            <button
              key={id}
              type="button"
              className={`intel-layer-btn ${layer === id ? "on" : ""}`}
              onClick={() => setLayer(id)}
            >
              {lbl(tr?.intelLayers, id, LAYER_LABEL[id])}
            </button>
          ))}
        </div>
        <div className="pmw-toolbar-actions">
          <button type="button" className="pmw-btn" onClick={() => fitView({ padding: 0.2, duration: 300 })}>
            {tr?.intelFit || "Fit"}
          </button>
          <button type="button" className="pmw-btn" onClick={resetView}>
            {tr?.intelReset || "Reset"}
          </button>
          <button type="button" className="pmw-btn" onClick={exportJson}>
            {tr?.intelExportJson || "Export JSON"}
          </button>
          <button type="button" className="pmw-btn primary" onClick={exportMarkdown}>
            {tr?.intelExportMd || "Export Markdown"}
          </button>
          <button
            type="button"
            className={`pmw-toggle ${summaryOpen ? "on" : ""}`}
            onClick={() => setSummaryOpen((v) => !v)}
            aria-pressed={summaryOpen}
            title={tr?.intelSummaryTitle || "Project summary"}
          >
            {tr?.intelSummaryShort || "Summary"}
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      <div className="intel-filters pmw-filters">
        {legendTypes.map((tp) => (
          <button
            key={tp}
            type="button"
            className={`intel-chip type-${tp} ${enabledTypes.has(tp) ? "on" : "off"}`}
            onClick={() => toggleType(tp)}
          >
            <span className="intel-chip-dot" />
            {lbl(tr?.intelNodeTypes, tp, NODE_TYPE_LABEL[tp])}
          </button>
        ))}
      </div>

      <div className="pmw-body">
        {/* Left: how to read + legend */}
        {helpOpen ? (
          <aside className="pmw-help" aria-label={tr?.intelHelpTitle || "How to read the map"}>
            <h4>{tr?.intelHelpTitle || "How to read the map"}</h4>
            <p className="pmw-muted">
              {tr?.intelHelpBody ||
                "Each card is a working part of the system. Arrows show how data flows between them. Switch layers to change the view, filter node types, then click any node and choose Read more for stack, inputs/outputs, logic, risks and files."}
            </p>
            <h5>{tr?.intelLayersTitle || "Layers"}</h5>
            <ul className="pmw-legend-list">
              {LAYERS.map((id) => (
                <li key={id}>
                  <span className={`pmw-layer-dot layer-${id}`} />
                  {lbl(tr?.intelLayers, id, LAYER_LABEL[id])}
                </li>
              ))}
            </ul>
            {legendTypes.length ? (
              <>
                <h5>{tr?.intelLegendTitle || "Node types"}</h5>
                <ul className="pmw-legend-list">
                  {legendTypes.map((tp) => (
                    <li key={tp}>
                      <span className={`pmw-type-dot type-${tp}`} />
                      {lbl(tr?.intelNodeTypes, tp, NODE_TYPE_LABEL[tp])}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </aside>
        ) : null}

        {/* Center: draggable / zoomable canvas */}
        <div className="intel-canvas pmw-canvas">
          <ReactFlow
            nodes={visibleNodes}
            edges={visibleEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={() => onSelectNode(null)}
            nodesDraggable
            nodesConnectable={false}
            minZoom={0.1}
            fitView
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} />
            <Controls />
            <MiniMap pannable zoomable nodeClassName={(n) => `mm-${(n.data as IntelNodeData)?.ntype || "file"}`} />
          </ReactFlow>
          {visibleNodes.length === 0 ? (
            <div className="intel-empty-layer">{tr?.intelEmptyLayer || "Nothing to show in this view."}</div>
          ) : null}
          {/* Node detail "Read more" drawer (host-provided). */}
          {selectedNodeId && renderNodeDetail ? (
            <div className="pmw-detail" role="dialog" aria-label={tr?.intelNodeDetails || "Node details"}>
              {renderNodeDetail(selectedNodeId)}
            </div>
          ) : null}
        </div>

        {/* Right: project summary + stats + tech/features/risks */}
        {summaryOpen ? (
          <aside className="pmw-summary" aria-label={tr?.intelSummaryTitle || "Project summary"}>
            <div className="pmw-summary-head">
              <h4>{projectName || tr?.intelSummaryTitle || "Project summary"}</h4>
            </div>
            <div className="pmw-stats">
              {statItems.map((s) => (
                <div key={s.key} className="pmw-stat">
                  <span className="pmw-stat-value">{s.value}</span>
                  <span className="pmw-stat-label">{s.label}</span>
                </div>
              ))}
            </div>
            {data.summary ? (
              <section className="pmw-section">
                <h5>{tr?.intelSummaryTitle || "Summary"}</h5>
                <p className="pmw-summary-text">{t(data.summary)}</p>
              </section>
            ) : null}
            {data.technologies?.length ? (
              <section className="pmw-section">
                <h5>{tr?.intelTechnologies || "Technologies"} ({data.technologies.length})</h5>
                <div className="pmw-tags">
                  {data.technologies.slice(0, 40).map((tech) => (
                    <span key={tech.id} className="pmw-tag" title={tech.category}>
                      {tech.name}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}
            {data.features?.length ? (
              <section className="pmw-section">
                <h5>{tr?.intelFeatures || "Features"} ({data.features.length})</h5>
                <ul className="pmw-list">
                  {data.features.slice(0, 30).map((f) => (
                    <li key={f.id}>{f.label}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {data.risks?.length ? (
              <section className="pmw-section">
                <h5>{tr?.intelRisks || "Risks"} ({data.risks.length})</h5>
                <ul className="pmw-risk-list">
                  {data.risks.slice(0, 20).map((r, i) => (
                    <li key={r.id || i} className={`sev-${r.severity}`}>
                      <b>{r.title}</b>
                      {r.detail ? <span>{t(r.detail)}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function ProjectMap(props: ProjectMapProps) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}

export default ProjectMap;
