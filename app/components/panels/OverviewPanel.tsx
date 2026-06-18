"use client";

import { useEffect, useState } from "react";
import type { GhostData } from "../../useGhostData";
import type { StepKey } from "../../i18n";
import { Json } from "../../api";
import { Onboarding } from "../Onboarding";

// Maps each dashboard stat to the panel that manages it.
const STAT_TO_STEP: Record<string, StepKey> = {
  topics: "sources",
  sources: "sources",
  knowledge_chunks: "ask",
  agent_skills: "skills",
  projects: "projects",
  project_decisions: "design",
  generated_plans: "plan",
  agent_logs: "overview"
};

export function OverviewPanel({ g }: { g: GhostData }) {
  const { t, stats, topics, projects, setActive } = g;
  const counts = (stats?.counts as Record<string, number>) || {};

  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    setDismissed(localStorage.getItem("ghost.onboarded") === "1");
  }, []);
  const dismiss = () => {
    localStorage.setItem("ghost.onboarded", "1");
    setDismissed(true);
  };

  // First-time onboarding: no topics and no projects yet.
  const isNew = topics.length === 0 && projects.length === 0;

  return (
    <section className="panel">
      {isNew && !dismissed ? <Onboarding g={g} onDismiss={dismiss} /> : null}

      <div className="stat-grid">
        {Object.keys(t.statLabels).map((k) => {
          const step = STAT_TO_STEP[k];
          return (
            <button
              key={k}
              type="button"
              className="stat-card"
              onClick={() => step && setActive(step)}
              aria-label={t.statLabels[k]}
            >
              <b>{counts[k] ?? "\u2014"}</b>
              <span>{t.statLabels[k]}</span>
            </button>
          );
        })}
      </div>
      <div className="text-block" style={{ marginTop: 18 }}>
        <h4>{t.recentTitle}</h4>
        {Array.isArray(stats?.recentLogs) && (stats!.recentLogs as Json[]).length ? (
          <ul className="log-list">
            {(stats!.recentLogs as Json[]).map((l) => (
              <li key={String(l.id)}>
                <span className="tag">{String(l.type)}</span> {String(l.message)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t.noEvents}</p>
        )}
      </div>
    </section>
  );
}
