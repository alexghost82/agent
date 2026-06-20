"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { FlowMap } from "../FlowMap";
import { MapModal } from "../MapModal";
import { seedFlow } from "../../flowSeed";

export function DesignPanel({ g }: { g: GhostData }) {
  const { t, projects, topics, skills, selectedProject, setSelectedProject, loading, output } = g;
  const [designSection, setDesignSection] = useState("");
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>([]);

  const [mapOpen, setMapOpen] = useState(false);
  const [mapNodes, setMapNodes] = useState<any[]>([]);
  const [mapEdges, setMapEdges] = useState<any[]>([]);
  const [mapSaving, setMapSaving] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  function toggleTopic(id: string) {
    setSelectedTopicIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
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
    </section>
  );
}
