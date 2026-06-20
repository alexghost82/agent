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
  applyNodeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  NODE_TYPES,
  NODE_TYPE_LABEL,
  LAYERS,
  LAYER_LABEL,
  type IntelLayerId,
  type IntelNodeType
} from "./intelTypes";

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
}
interface RawEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  layers: IntelLayerId[];
}

export interface ProjectMapData {
  nodes: RawNode[];
  edges: RawEdge[];
  technologies: { id: string; name: string; category: string; confidence: string }[];
  features: { id: string; key: string; label: string; description?: string; confidence: string }[];
  insights: { id: string; kind: string; severity: string; title: string; detail: string; confidence: string }[];
  stats: { files: number; nodes: number; edges: number };
}

export interface ProjectMapProps {
  data: ProjectMapData;
  t: any;
  onSelectNode: (nodeId: string | null) => void;
  selectedNodeId: string | null;
}

// Custom node renderer — colour + glyph come from CSS via the `type-<x>` class.
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

function FlowInner({ data, t, onSelectNode, selectedNodeId }: ProjectMapProps) {
  const [layer, setLayer] = useState<IntelLayerId>("overview");
  const [enabledTypes, setEnabledTypes] = useState<Set<IntelNodeType>>(new Set(NODE_TYPES));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const { fitView } = useReactFlow();

  const lbl = (map: Record<string, string>, key: string, fallback: string) =>
    (map && map[key]) || fallback;

  // A node is collapsible if it parents other nodes (feature/module).
  const collapsibleIds = useMemo(() => {
    const parents = new Set<string>();
    for (const n of data.nodes) if (n.group) parents.add(n.group);
    return parents;
  }, [data.nodes]);

  const q = query.trim().toLowerCase();

  const visibleNodes = useMemo<Node[]>(() => {
    return data.nodes
      .filter((n) => n.layers.includes(layer))
      .filter((n) => enabledTypes.has(n.type))
      .filter((n) => !(n.group && collapsed.has(n.group)))
      .map((n) => {
        const match = q.length > 0 && n.label.toLowerCase().includes(q);
        const dim = q.length > 0 && !match;
        const pos = positions[n.id] || n.position;
        return {
          id: n.id,
          type: "intel",
          position: pos,
          selected: n.id === selectedNodeId,
          data: {
            label: n.label,
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
  }, [data.nodes, layer, enabledTypes, collapsed, q, positions, selectedNodeId, collapsibleIds]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo<Edge[]>(() => {
    return data.edges
      .filter((e) => e.layers.includes(layer))
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        className: `intel-edge type-${e.type}`,
        animated: layer === "dataFlow" || layer === "uiFlow"
      }));
  }, [data.edges, layer, visibleIds]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Persist drag positions so filtering doesn't reset the layout.
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
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const d = node.data as IntelNodeData;
      if (!d.collapsible) return;
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    },
    []
  );

  // Reframe when the active layer changes.
  useEffect(() => {
    const id = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60);
    return () => clearTimeout(id);
  }, [layer, fitView]);

  const presentTypes = useMemo(() => {
    const s = new Set<IntelNodeType>();
    for (const n of data.nodes) s.add(n.type);
    return s;
  }, [data.nodes]);

  return (
    <div className="intel-map">
      <div className="intel-toolbar">
        <div className="intel-layers">
          {LAYERS.map((id) => (
            <button
              key={id}
              type="button"
              className={`intel-layer-btn ${layer === id ? "on" : ""}`}
              onClick={() => setLayer(id)}
            >
              {lbl(t?.intelLayers, id, LAYER_LABEL[id])}
            </button>
          ))}
        </div>
        <div className="intel-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t?.intelSearchPlaceholder || "Search nodes\u2026"}
            aria-label={t?.intelSearchPlaceholder || "Search nodes"}
          />
        </div>
      </div>

      <div className="intel-filters">
        {NODE_TYPES.filter((tp) => presentTypes.has(tp)).map((tp) => (
          <button
            key={tp}
            type="button"
            className={`intel-chip type-${tp} ${enabledTypes.has(tp) ? "on" : "off"}`}
            onClick={() => toggleType(tp)}
          >
            <span className="intel-chip-dot" />
            {lbl(t?.intelNodeTypes, tp, NODE_TYPE_LABEL[tp])}
          </button>
        ))}
      </div>

      <div className="intel-canvas">
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
          <Background />
          <Controls />
          <MiniMap pannable zoomable nodeClassName={(n) => `mm-${(n.data as IntelNodeData)?.ntype || "file"}`} />
        </ReactFlow>
        {visibleNodes.length === 0 ? (
          <div className="intel-empty-layer">{t?.intelEmptyLayer || "Nothing to show in this view."}</div>
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
