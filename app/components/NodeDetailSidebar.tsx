"use client";

import { useEffect, useState } from "react";
import type { Json } from "../api";
import { NODE_TYPE_LABEL, type IntelNodeType } from "./intelTypes";
import type { NodeDetails } from "../types/projectMap";

export interface NodeDetailSidebarProps {
  projectId: string;
  nodeId: string | null;
  loadNodeDetail: (projectId: string, nodeId: string) => Promise<Json | null>;
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
  t: any;
}

interface Related {
  id: string;
  label: string;
  type: IntelNodeType;
  edgeType: string;
  direction: "in" | "out";
}
interface Risk {
  title: string;
  severity: string;
  detail: string;
}

export function NodeDetailSidebar({ projectId, nodeId, loadNodeDetail, onClose, onNavigate, t }: NodeDetailSidebarProps) {
  const [detail, setDetail] = useState<Json | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    loadNodeDetail(projectId, nodeId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, nodeId, loadNodeDetail]);

  if (!nodeId) return null;

  const type = detail?.type as IntelNodeType | undefined;
  const related = (detail?.related as Related[] | undefined) || [];
  const files = (detail?.files as string[] | undefined) || [];
  const risks = (detail?.risks as Risk[] | undefined) || [];
  const metadata = (detail?.metadata as Record<string, unknown> | undefined) || {};
  const details = (detail?.details as NodeDetails | undefined) || undefined;
  const inferred = detail?.confidence === "inferred";

  const touches = (kinds: IntelNodeType[]) => related.filter((r) => kinds.includes(r.type));
  const apis = touches(["apiRoute"]);
  const models = touches(["dbModel"]);
  const services = touches(["service"]);
  const packages = touches(["externalPackage"]);

  return (
    <aside className="intel-sidebar" aria-label={t?.intelNodeDetails || "Node details"}>
      <div className="intel-sidebar-head">
        <div>
          {type ? <span className={`intel-pill type-${type}`}>{(t?.intelNodeTypes && t.intelNodeTypes[type]) || NODE_TYPE_LABEL[type] || type}</span> : null}
          <h4>{(detail?.label as string) || (loading ? (t?.loading || "Loading\u2026") : nodeId)}</h4>
        </div>
        <button className="ghost sm" onClick={onClose} aria-label={t?.close || "Close"} type="button">
          {"\u00d7"}
        </button>
      </div>

      {loading ? (
        <p className="muted">{t?.loading || "Loading\u2026"}</p>
      ) : !detail ? (
        <p className="muted">{t?.intelNodeMissing || "No saved details for this node."}</p>
      ) : (
        <div className="intel-sidebar-body">
          {detail.description ? (
            <p className="intel-desc">
              {String(detail.description)}
              {inferred ? <span className="intel-badge inferred inline">{t?.intelInferred || "AI inferred"}</span> : null}
            </p>
          ) : null}

          {details ? (
            <section className="intel-details">
              {details.purpose ? (
                <div className="intel-detail-row">
                  <h5>{t?.intelPurpose || "Purpose"}</h5>
                  <p>{details.purpose}</p>
                </div>
              ) : null}
              {details.logic ? (
                <div className="intel-detail-row">
                  <h5>{t?.intelLogic || "Logic"}</h5>
                  <p>{details.logic}</p>
                </div>
              ) : null}
              {details.stack?.length ? (
                <div className="intel-detail-row">
                  <h5>{t?.intelStack || "Stack"}</h5>
                  <div className="pmw-tags">
                    {details.stack.map((s, i) => (
                      <span key={`${s}-${i}`} className="pmw-tag">{s}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {details.inputs?.length ? (
                <div className="intel-detail-row">
                  <h5>{t?.intelInputs || "Inputs"}</h5>
                  <ul className="intel-io-list">
                    {details.inputs.map((s, i) => (
                      <li key={`in-${i}`}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {details.outputs?.length ? (
                <div className="intel-detail-row">
                  <h5>{t?.intelOutputs || "Outputs"}</h5>
                  <ul className="intel-io-list">
                    {details.outputs.map((s, i) => (
                      <li key={`out-${i}`}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {apis.length || models.length || services.length || packages.length ? (
            <section>
              <h5>{t?.intelTouches || "Touches"}</h5>
              <div className="intel-touch-grid">
                {apis.length ? <div><b>{t?.intelApis || "APIs / routes"}</b><span>{apis.length}</span></div> : null}
                {services.length ? <div><b>{t?.intelServices || "Services"}</b><span>{services.length}</span></div> : null}
                {models.length ? <div><b>{t?.intelModels || "DB models"}</b><span>{models.length}</span></div> : null}
                {packages.length ? <div><b>{t?.intelPackages || "Packages"}</b><span>{packages.length}</span></div> : null}
              </div>
            </section>
          ) : null}

          {files.length ? (
            <section>
              <h5>{t?.intelFiles || "Files"} ({files.length})</h5>
              <ul className="intel-file-list">
                {files.slice(0, 40).map((f) => (
                  <li key={f} title={f}><code>{f}</code></li>
                ))}
              </ul>
            </section>
          ) : null}

          {related.length ? (
            <section>
              <h5>{t?.intelConnections || "Connections"} ({related.length})</h5>
              <ul className="intel-rel-list">
                {related.slice(0, 40).map((r, i) => (
                  <li key={`${r.id}-${i}`}>
                    <button type="button" className="intel-rel" onClick={() => onNavigate(r.id)}>
                      <span className={`intel-rel-dir ${r.direction}`}>{r.direction === "out" ? "\u2192" : "\u2190"}</span>
                      <span className="intel-rel-edge">{r.edgeType.replace(/_/g, " ")}</span>
                      <span className="intel-rel-label">{r.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {risks.length ? (
            <section>
              <h5>{t?.intelRisks || "Risks"}</h5>
              <ul className="intel-risk-list">
                {risks.map((r, i) => (
                  <li key={i} className={`sev-${r.severity}`}>
                    <b>{r.title}</b>
                    <span>{r.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {Object.keys(metadata).length ? (
            <section>
              <h5>{t?.intelMetadata || "Metadata"}</h5>
              <dl className="intel-meta">
                {Object.entries(metadata)
                  .filter(([k]) => k !== "hasRisk")
                  .slice(0, 12)
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                    </div>
                  ))}
              </dl>
            </section>
          ) : null}
        </div>
      )}
    </aside>
  );
}

export default NodeDetailSidebar;
