"use client";

import { useEffect, useState } from "react";
import type { GhostData } from "../../useGhostData";
import type { StepKey } from "../../i18n";
import { STEP_META } from "../../i18n";
import { Icon } from "../../icons";
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

// The guided pipeline shown as a horizontal workflow strip.
const PIPELINE: StepKey[] = ["sources", "skills", "projects", "ask", "design", "plan", "build"];

export function OverviewPanel({ g }: { g: GhostData }) {
  const { t, stats, topics, projects, setActive, active } = g;
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
  const recentLogs = (Array.isArray(stats?.recentLogs) ? (stats!.recentLogs as Json[]) : []);
  const activeStepIdx = PIPELINE.indexOf(active);

  return (
    <section className="panel">
      {isNew && !dismissed ? <Onboarding g={g} onDismiss={dismiss} /> : null}

      <div className="stat-grid dash-stats">
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

      <div className="dash-grid">
        <div className="dash-main">
          <div className="card">
            <div className="card-head">
              <h3>{t.workflow}</h3>
            </div>
            <div className="workflow-strip">
              {PIPELINE.map((k, i) => (
                <button
                  key={k}
                  type="button"
                  className={`wf-step ${active === k ? "is-active" : ""} ${activeStepIdx > i ? "is-done" : ""}`}
                  onClick={() => setActive(k)}
                >
                  <span className="wf-ic">
                    <Icon name={STEP_META[k].icon} />
                  </span>
                  <span className="wf-label">{t.steps[k].title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className="dash-rail">
          <div className="card">
            <div className="card-head">
              <h3>{t.recentTitle}</h3>
            </div>
            {recentLogs.length ? (
              <ul className="activity-list">
                {recentLogs.slice(0, 8).map((l) => (
                  <li key={String(l.id)}>
                    <span className="activity-dot" />
                    <div className="activity-main">
                      <span className="activity-msg">{String(l.message)}</span>
                      <span className="tag">{String(l.type)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.noEvents}</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
