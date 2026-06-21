"use client";

import { useCallback, useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { FlowMap } from "../FlowMap";
import { MapModal } from "../MapModal";
import { seedFlow } from "../../flowSeed";
import { DesignMapCanvas } from "../design-map/DesignMapCanvas";
import type { DesignMapNode, DesignMapEdge } from "../design-map/types";

type PickerState =
  | { kind: "skill"; position?: { x: number; y: number } }
  | { kind: "podskill"; position?: { x: number; y: number }; skillId: string }
  | null;

// Look for podskills under any of the common array keys a skill might carry.
function getPodskills(skill: any): any[] {
  if (!skill) return [];
  const candidates = [skill.podskills, skill.subskills, skill.children, skill.steps, skill.items];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
}

export function DesignPanel({ g }: { g: GhostData }) {
  const { t, projects, topics, skills, selectedProject, setSelectedProject, loading, output } = g;
  const [designSection, setDesignSection] = useState("");
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>([]);

  const [mapOpen, setMapOpen] = useState(false);
  const [mapNodes, setMapNodes] = useState<any[]>([]);
  const [mapEdges, setMapEdges] = useState<any[]>([]);
  const [mapSaving, setMapSaving] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  // Design Map (new canvas) local state.
  const [dmOpen, setDmOpen] = useState(false);
  const [dmLoading, setDmLoading] = useState(false);
  const [dmLoaded, setDmLoaded] = useState(false);
  const [dmHasMap, setDmHasMap] = useState(false);
  const [dmNodes, setDmNodes] = useState<DesignMapNode[]>([]);
  const [dmEdges, setDmEdges] = useState<DesignMapEdge[]>([]);
  const [dmSaving, setDmSaving] = useState(false);
  const [dmProjectId, setDmProjectId] = useState("");
  const [picker, setPicker] = useState<PickerState>(null);

  function toggleTopic(id: string) {
    setSelectedTopicIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  }

  // Apply a freshly returned design map (from load/save/add helpers) to local state.
  const applyMap = useCallback((map: any) => {
    if (map && Array.isArray(map.nodes)) {
      setDmNodes(map.nodes as DesignMapNode[]);
      setDmEdges(Array.isArray(map.edges) ? (map.edges as DesignMapEdge[]) : []);
      setDmHasMap(true);
    } else {
      setDmNodes([]);
      setDmEdges([]);
      setDmHasMap(false);
    }
  }, []);

  async function openDesignMap() {
    if (!selectedProject) return;
    const projectId = selectedProject;
    setDmOpen(true);
    setDmLoading(true);
    setDmLoaded(false);
    setDmProjectId(projectId);
    setPicker(null);
    g.setSelectedDesignMapProject(projectId);
    try {
      const map = await g.loadDesignMap(projectId);
      applyMap(map);
    } finally {
      setDmLoading(false);
      setDmLoaded(true);
    }
  }

  const onDesignMapSave = useCallback(
    async (nodes: DesignMapNode[], edges: DesignMapEdge[]) => {
      if (!dmProjectId) return;
      setDmSaving(true);
      try {
        const saved = await g.saveDesignMap(dmProjectId, { nodes, edges });
        if (saved && Array.isArray(saved.nodes)) {
          applyMap(saved);
        } else {
          setDmNodes(nodes);
          setDmEdges(edges);
          setDmHasMap(true);
        }
      } finally {
        setDmSaving(false);
      }
    },
    [dmProjectId, g, applyMap]
  );

  const onAddSkill = useCallback((position?: { x: number; y: number }) => {
    setPicker({ kind: "skill", position });
  }, []);

  const onAddPodskill = useCallback((position?: { x: number; y: number }) => {
    // Stage the podskill picker; the skill must be chosen first.
    setPicker({ kind: "podskill", position, skillId: "" });
  }, []);

  async function chooseSkill(skill: any) {
    if (!dmProjectId) return;
    const pos = picker?.position;
    setPicker(null);
    setDmSaving(true);
    try {
      const r = await g.addSkillToDesignMap(dmProjectId, String(skill.id), pos);
      if (r && (r as any).map) applyMap((r as any).map);
    } finally {
      setDmSaving(false);
    }
  }

  async function choosePodskill(skill: any, podskillId: string) {
    if (!dmProjectId) return;
    const pos = picker?.kind === "podskill" ? picker.position : undefined;
    setPicker(null);
    setDmSaving(true);
    try {
      const r = await g.addPodskillToDesignMap(dmProjectId, String(skill.id), podskillId, pos);
      if (r && (r as any).map) applyMap((r as any).map);
    } finally {
      setDmSaving(false);
    }
  }

  async function openMap() {
    setMapReady(false);
    setMapOpen(true);
    const saved = await g.loadMap(selectedProject, "design");
    if (saved && Array.isArray(saved.nodes) && saved.nodes.length) {
      setMapNodes(saved.nodes as any[]);
      setMapEdges((saved.edges as any[]) || []);
    } else {
      const proj = g.projects.find((p) => String(p.id) === selectedProject);
      const designText = String((g.output.design as any)?.plan || "");
      const projSkills = g.skills.filter((s) =>
        Array.isArray(proj?.skillIds) ? (proj!.skillIds as string[]).includes(String(s.id)) : false
      );
      const { nodes, edges } = seedFlow("design", {
        projectName: proj?.name,
        designText,
        skills: projSkills
      });
      setMapNodes(nodes);
      setMapEdges(edges);
    }
    setMapReady(true);
  }

  return (
    <section className="panel">
      <div className="explain">{t.designExplain}</div>
      <div className="form-card">
        <label>{t.selectProject}</label>
        <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">{"\u2014"}</option>
          {projects.map((p) => (
            <option key={String(p.id)} value={String(p.id)}>
              {String(p.name)}
            </option>
          ))}
        </select>
        <label>{t.ideaLabel}</label>
        <textarea
          value={designSection}
          onChange={(e) => setDesignSection(e.target.value)}
          placeholder={t.ideaPlaceholder}
        />
        <label>{t.addSkillCategories}</label>
        {topics.length ? (
          <div className="skill-pick">
            {topics.map((tp) => (
              <label key={String(tp.id)} className="check">
                <input
                  type="checkbox"
                  checked={selectedTopicIds.includes(String(tp.id))}
                  onChange={() => toggleTopic(String(tp.id))}
                />
                <span>{String(tp.name)}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="muted">{t.noTopics}</p>
        )}
        <button
          className="primary"
          onClick={() => g.design(selectedProject, designSection, selectedTopicIds)}
          disabled={loading.design || !selectedProject}
        >
          <Icon name="plan" /> {loading.design ? t.designing : t.designBtn}
        </button>
        <div className="row-actions">
          <button className="ghost" onClick={openMap} disabled={!selectedProject}>
            {t.showUpdateMap}
          </button>
        </div>
      </div>
      <ResultView k="design" output={output} loading={loading} t={t} />
      <MapModal open={mapOpen} title={t.mapTitle} onClose={() => setMapOpen(false)} closeLabel={t.closeMap}>
        {mapReady ? (
          <FlowMap
            initialNodes={mapNodes as any}
            initialEdges={mapEdges as any}
            t={t}
            saving={mapSaving}
            onSave={async (nodes, edges) => {
              setMapSaving(true);
              try {
                await g.saveMap(selectedProject, "design", nodes as any, edges as any);
              } finally {
                setMapSaving(false);
              }
            }}
          />
        ) : null}
      </MapModal>

      <section className="design-map-section form-card">
        <div className="design-map-header">
          <h3>{(t as any).designMap || "Design Map"}</h3>
          <button className="ghost" onClick={openDesignMap} disabled={!selectedProject}>
            {(t as any).openDesignMap || "Open Design Map"}
          </button>
        </div>

        {dmOpen ? (
          dmLoading ? (
            <p className="muted">{(t as any).loading || "Loading\u2026"}</p>
          ) : dmLoaded && !dmHasMap && dmNodes.length === 0 ? (
            <p className="muted">{(t as any).noDesignMapYet || "No design map yet."}</p>
          ) : (
            <div className="design-map-shell" style={{ minHeight: 600, height: 600 }}>
              <DesignMapCanvas
                nodes={dmNodes}
                edges={dmEdges}
                t={t}
                saving={dmSaving}
                onSave={onDesignMapSave}
                onAddSkill={onAddSkill}
                onAddPodskill={onAddPodskill}
              />
            </div>
          )
        ) : null}

        {picker && picker.kind === "skill" ? (
          <div className="design-map-picker">
            <label>{(t as any).addSkillToMap || "Add skill"}</label>
            <select
              defaultValue=""
              onChange={(e) => {
                const skill = (skills as any[]).find((s) => String(s.id) === e.target.value);
                if (skill) chooseSkill(skill);
              }}
            >
              <option value="">{"\u2014"}</option>
              {(skills as any[]).map((s) => (
                <option key={String(s.id)} value={String(s.id)}>
                  {String(s.skillName ?? s.name ?? s.id)}
                </option>
              ))}
            </select>
            <button className="ghost" onClick={() => setPicker(null)}>
              {(t as any).cancel || "Cancel"}
            </button>
          </div>
        ) : null}

        {picker && picker.kind === "podskill" ? (
          <div className="design-map-picker">
            <label>{(t as any).addPodskillToMap || "Add podskill"}</label>
            <select
              value={picker.skillId}
              onChange={(e) =>
                setPicker({ kind: "podskill", position: picker.position, skillId: e.target.value })
              }
            >
              <option value="">{"\u2014"}</option>
              {(skills as any[]).map((s) => (
                <option key={String(s.id)} value={String(s.id)}>
                  {String(s.skillName ?? s.name ?? s.id)}
                </option>
              ))}
            </select>
            {(() => {
              const skill = (skills as any[]).find((s) => String(s.id) === picker.skillId);
              const pods = getPodskills(skill);
              if (!picker.skillId) return null;
              if (!pods.length) {
                return (
                  <button className="ghost" disabled>
                    {(t as any).noPodskills || "No podskills"}
                  </button>
                );
              }
              return (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (skill && e.target.value !== "") choosePodskill(skill, e.target.value);
                  }}
                >
                  <option value="">{"\u2014"}</option>
                  {pods.map((p: any, idx: number) => (
                    <option key={String(p?.id ?? idx)} value={String(p?.id ?? idx)}>
                      {String(p?.name ?? p?.label ?? p?.title ?? `#${idx + 1}`)}
                    </option>
                  ))}
                </select>
              );
            })()}
            <button className="ghost" onClick={() => setPicker(null)}>
              {(t as any).cancel || "Cancel"}
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}
