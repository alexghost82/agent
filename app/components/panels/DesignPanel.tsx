"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";

export function DesignPanel({ g }: { g: GhostData }) {
  const { t, projects, selectedProject, setSelectedProject, loading, output } = g;
  const [designSection, setDesignSection] = useState("");

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
        <button className="primary" onClick={() => g.design(selectedProject, designSection)} disabled={loading.design || !selectedProject}>
          <Icon name="plan" /> {loading.design ? t.designing : t.designBtn}
        </button>
      </div>
      <ResultView k="design" output={output} loading={loading} t={t} />
    </section>
  );
}
