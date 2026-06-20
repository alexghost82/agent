"use client";

import { useCallback, useState } from "react";
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

export interface FlowMapProps {
  initialNodes: Node[];
  initialEdges: Edge[];
  t: any;
  onSave: (nodes: Node[], edges: Edge[]) => Promise<void> | void;
  saving?: boolean;
}

export function FlowMap({ initialNodes, initialEdges, t, onSave, saving }: FlowMapProps) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((cur) => applyNodeChanges(changes, cur)),
    []
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((cur) => applyEdgeChanges(changes, cur)),
    []
  );
  const onConnect = useCallback(
    (connection: Connection) => setEdges((cur) => addEdge(connection, cur)),
    []
  );

  const addNode = useCallback(() => {
    const id = `n-${Date.now()}`;
    setNodes((cur) => [
      ...cur,
      {
        id,
        position: { x: 200 + (cur.length % 5) * 30, y: 120 + (cur.length % 5) * 30 },
        data: { label: t?.nodeLabelPlaceholder || "Node label" },
        type: "default"
      }
    ]);
  }, [t]);

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const current =
      node.data && typeof node.data.label === "string" ? node.data.label : "";
    const next = window.prompt(t?.nodeLabelPlaceholder || "Node label", current);
    if (next == null) return;
    setNodes((cur) =>
      cur.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, label: next } } : n))
    );
  }, [t]);

  const deleteSelected = useCallback(() => {
    setNodes((cur) => {
      const removed = new Set(cur.filter((n) => n.selected).map((n) => n.id));
      if (removed.size === 0) {
        setEdges((e) => e.filter((edge) => !edge.selected));
        return cur;
      }
      setEdges((e) =>
        e.filter(
          (edge) => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)
        )
      );
      return cur.filter((n) => !n.selected);
    });
  }, []);

  const handleSave = useCallback(() => {
    onSave(nodes, edges);
  }, [onSave, nodes, edges]);

  return (
    <div className="flowmap-wrap">
      <div className="flowmap-toolbar">
        <button className="ghost sm" onClick={addNode} type="button">
          {t?.addNode || "Add node"}
        </button>
        <button className="danger-btn" onClick={deleteSelected} type="button">
          {t?.deleteNode || "Delete node"}
        </button>
        <button className="primary" onClick={handleSave} disabled={saving} type="button">
          {saving ? `${t?.saveMap || "Save map"}\u2026` : t?.saveMap || "Save map"}
        </button>
      </div>
      <div className="flowmap-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={onNodeDoubleClick}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
}

export default FlowMap;
