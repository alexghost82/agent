"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GhostData } from "../useGhostData";
import type { Json } from "../api";
import { MapModal } from "./MapModal";
import { ProjectMap, type ProjectMapData } from "./ProjectMap";
import { NodeDetailSidebar } from "./NodeDetailSidebar";

export interface ProjectMapModalProps {
  g: GhostData;
  projectId: string;
  projectName: string;
  onClose: () => void;
}

const ACTIVE = new Set(["pending", "queued", "scanning", "analyzing"]);

export function ProjectMapModal({ g, projectId, projectName, onClose }: ProjectMapModalProps) {
  const { t } = g;
  const [scan, setScan] = useState<Json | null>(null);
  const [map, setMap] = useState<ProjectMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const s = await g.loadScanStatus(projectId);
    setScan(s);
    const status = String(s?.status || "");
    if (status === "completed") {
      const m = await g.loadIntelMap(projectId);
      if (m && Array.isArray((m as any).nodes)) setMap(m as unknown as ProjectMapData);
    }
    setLoading(false);
    return status;
  }, [g, projectId]);

  useEffect(() => {
    let cancelled = false;
    refresh();
    pollRef.current = setInterval(async () => {
      const status = await refresh();
      if (cancelled || !ACTIVE.has(status)) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    }, 2500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const status = String(scan?.status || "none");
  const done = Number(scan?.progressDone ?? 0);
  const total = Number(scan?.progressTotal ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const completed = status === "completed" && map && map.nodes.length > 0;

  return (
    <MapModal open title={`${t.intelMapTitle || "Project map"} \u2014 ${projectName}`} onClose={onClose} closeLabel={t.closeMap}>
      {loading ? (
        <div className="intel-state">
          <span className="spinner" /> {t.loading || "Loading\u2026"}
        </div>
      ) : completed ? (
        <div className="intel-modal-grid">
          <ProjectMap
            data={map!}
            t={t}
            projectName={projectName}
            onSelectNode={setSelectedNodeId}
            selectedNodeId={selectedNodeId}
            renderNodeDetail={(nodeId) => (
              <NodeDetailSidebar
                projectId={projectId}
                nodeId={nodeId}
                loadNodeDetail={g.loadNodeDetail}
                onClose={() => setSelectedNodeId(null)}
                onNavigate={setSelectedNodeId}
                t={t}
              />
            )}
          />
        </div>
      ) : status === "failed" ? (
        <div className="intel-state error">
          <p><strong>{t.errorWord || "Error"}:</strong> {String(scan?.error || t.requestFailed || "Scan failed")}</p>
          <p className="muted">{t.intelRescanHint || "Try re-scanning the project."}</p>
        </div>
      ) : ACTIVE.has(status) ? (
        <div className="intel-state">
          <div className="ingest-row">
            <span className="spinner" />
            <span>
              {t.intelScanning || "Analyzing project"} {"\u2014"} {t[`scanPhase_${String(scan?.phase || "")}`] || String(scan?.phase || status)}
              {total > 0 ? ` (${done}/${total})` : ""}
            </span>
          </div>
          <div className="progress-track">
            <div className={`progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
        </div>
      ) : (
        <div className="intel-state">
          <p className="muted">{t.intelNoScan || "This project has not been scanned yet."}</p>
        </div>
      )}
    </MapModal>
  );
}

export default ProjectMapModal;
