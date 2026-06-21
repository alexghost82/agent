"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { DesignMapNode as DesignMapNodeComponent } from "./DesignMapNode";
import { DesignMapToolbar } from "./DesignMapToolbar";
import { DesignMapSidebar } from "./DesignMapSidebar";
import type {
  DesignMapNode,
  DesignMapEdge,
  DesignMapNodeType,
  DesignMapEdgeType
} from "./types";

const AUTOSAVE_DELAY_MS = 800;
const DEFAULT_EDGE_TYPE: DesignMapEdgeType = "related_to";

export interface DesignMapCanvasProps {
  nodes: DesignMapNode[];
  edges: DesignMapEdge[];
  onSave: (nodes: DesignMapNode[], edges: DesignMapEdge[]) => Promise<void> | void;
  onAddSkill?: (position: { x: number; y: number }) => void;
  onAddPodskill?: (position: { x: number; y: number }) => void;
  saving?: boolean;
  t?: any;
}

// ---- conversion helpers: domain <-> React Flow ----

function domainNodeToRf(node: DesignMapNode): Node {
  return {
    id: node.id,
    type: "designNode",
    position: node.position,
    data: {
      type: node.type,
      label: node.label,
      description: node.description,
      skillId: node.skillId,
      podskillId: node.podskillId,
      confidence: node.confidence,
      ...(node.data ?? {})
    }
  };
}

function rfNodeToDomain(node: Node): DesignMapNode {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const {
    type,
    label,
    description,
    skillId,
    podskillId,
    confidence,
    ...rest
  } = data;
  return {
    id: node.id,
    type: (type as DesignMapNodeType) ?? "note",
    label: typeof label === "string" ? label : "",
    description: typeof description === "string" ? description : undefined,
    position: node.position,
    skillId: typeof skillId === "string" ? skillId : undefined,
    podskillId: typeof podskillId === "string" ? podskillId : undefined,
    confidence: confidence as DesignMapNode["confidence"],
    data: Object.keys(rest).length > 0 ? rest : undefined
  };
}

function domainEdgeToRf(edge: DesignMapEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    data: { type: edge.type, ...(edge.data ?? {}) }
  };
}

function rfEdgeToDomain(edge: Edge): DesignMapEdge {
  const data = (edge.data ?? {}) as Record<string, unknown>;
  const { type, ...rest } = data;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: (type as DesignMapEdgeType) ?? DEFAULT_EDGE_TYPE,
    label: typeof edge.label === "string" ? edge.label : undefined,
    data: Object.keys(rest).length > 0 ? rest : undefined
  };
}

export function DesignMapCanvas({
  nodes: initialNodes,
  edges: initialEdges,
  onSave,
  onAddSkill,
  onAddPodskill,
  saving,
  t
}: DesignMapCanvasProps) {
  const [nodes, setNodes] = useState<Node[]>(() => initialNodes.map(domainNodeToRf));
  const [edges, setEdges] = useState<Edge[]>(() => initialEdges.map(domainEdgeToRf));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTypeFilters, setActiveTypeFilters] = useState<DesignMapNodeType[]>([]);
  const [dirty, setDirty] = useState(false);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addCounter = useRef(0);

  const clearAutosave = useCallback(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  }, []);

  const markDirty = useCallback(() => setDirty(true), []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((cur) => applyNodeChanges(changes, cur));
      markDirty();
    },
    [markDirty]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((cur) => applyEdgeChanges(changes, cur));
      markDirty();
    },
    [markDirty]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((cur) =>
        addEdge(
          {
            ...connection,
            id: `e-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
            data: { type: DEFAULT_EDGE_TYPE }
          },
          cur
        )
      );
      markDirty();
    },
    [markDirty]
  );

  const addNode = useCallback(
    (type: DesignMapNodeType) => {
      const n = addCounter.current++;
      const id = `node-${Date.now()}-${n}`;
      const rfNode = domainNodeToRf({
        id,
        type,
        label: type,
        position: { x: 200 + (n % 6) * 40, y: 140 + (n % 6) * 40 }
      });
      setNodes((cur) => [...cur, rfNode]);
      setSelectedId(id);
      markDirty();
    },
    [markDirty]
  );

  const handleAddSkill = useCallback(() => {
    onAddSkill?.({ x: 240, y: 160 });
  }, [onAddSkill]);

  const handleAddPodskill = useCallback(() => {
    onAddPodskill?.({ x: 240, y: 160 });
  }, [onAddPodskill]);

  const onToggleTypeFilter = useCallback((type: DesignMapNodeType) => {
    setActiveTypeFilters((cur) =>
      cur.includes(type) ? cur.filter((x) => x !== type) : [...cur, type]
    );
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
  }, []);

  // Update the selected node's editable fields from the sidebar.
  const onSidebarChange = useCallback(
    (patch: Partial<DesignMapNode>) => {
      if (!selectedId) return;
      setNodes((cur) =>
        cur.map((n) =>
          n.id === selectedId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...(patch.label !== undefined ? { label: patch.label } : {}),
                  ...(patch.description !== undefined
                    ? { description: patch.description }
                    : {})
                }
              }
            : n
        )
      );
      markDirty();
    },
    [selectedId, markDirty]
  );

  const selectedDomainNode = useMemo<DesignMapNode | null>(() => {
    if (!selectedId) return null;
    const rf = nodes.find((n) => n.id === selectedId);
    return rf ? rfNodeToDomain(rf) : null;
  }, [selectedId, nodes]);

  // ---- save (manual + debounced autosave) ----

  const doSave = useCallback(async () => {
    clearAutosave();
    const domainNodes = nodes.map(rfNodeToDomain);
    const domainEdges = edges.map(rfEdgeToDomain);
    await onSave(domainNodes, domainEdges);
    setDirty(false);
  }, [clearAutosave, nodes, edges, onSave]);

  const handleManualSave = useCallback(() => {
    void doSave();
  }, [doSave]);

  useEffect(() => {
    if (!dirty) return;
    clearAutosave();
    autosaveTimer.current = setTimeout(() => {
      void doSave();
    }, AUTOSAVE_DELAY_MS);
    return clearAutosave;
  }, [dirty, nodes, edges, doSave, clearAutosave]);

  useEffect(() => clearAutosave, [clearAutosave]);

  // ---- visual filtering (search + type filters), non-destructive ----

  const { visibleNodes, visibleEdges } = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = nodes.filter((n) => {
      const data = (n.data ?? {}) as Record<string, unknown>;
      const type = data.type as DesignMapNodeType | undefined;
      const label = typeof data.label === "string" ? data.label.toLowerCase() : "";
      const matchesSearch = query === "" || label.includes(query);
      const matchesType =
        activeTypeFilters.length === 0 ||
        (type !== undefined && activeTypeFilters.includes(type));
      return matchesSearch && matchesType;
    });
    const visibleIds = new Set(visible.map((n) => n.id));
    const vEdges = edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );
    return { visibleNodes: visible, visibleEdges: vEdges };
  }, [nodes, edges, search, activeTypeFilters]);

  const nodeTypes = useMemo(() => ({ designNode: DesignMapNodeComponent }), []);

  return (
    <div className="design-map-shell">
      <DesignMapToolbar
        onAddNode={addNode}
        onAddSkill={handleAddSkill}
        onAddPodskill={handleAddPodskill}
        onSave={handleManualSave}
        search={search}
        onSearchChange={setSearch}
        activeTypeFilters={activeTypeFilters}
        onToggleTypeFilter={onToggleTypeFilter}
        dirty={dirty}
        saving={!!saving}
        t={t}
      />
      <div className="design-map-canvas">
        <ReactFlow
          nodes={visibleNodes}
          edges={visibleEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
      <DesignMapSidebar
        node={selectedDomainNode}
        onChange={onSidebarChange}
        onClose={onPaneClick}
        t={t}
      />
    </div>
  );
}

export default DesignMapCanvas;
