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

// Icon shown in each stat card badge.
const STAT_ICON: Record<string, string> = {
  topics: "learn",
  sources: "link",
  knowledge_chunks: "ask",
  agent_skills: "skills",
  projects: "project",
  project_decisions: "plan",
  generated_plans: "generate",
  agent_logs: "overview"
};

// The guided pipeline shown as a horizontal workflow strip.
const PIPELINE: StepKey[] = ["sources", "skills", "projects", "ask", "design", "plan", "build"];

// Best-effort relative time from a log row's timestamp.
function relTime(l: Json): string {
  const raw = l.createdAt ?? l.created_at ?? l.ts ?? l.time ?? l.timestamp;
  const ms = typeof raw === "number" ? raw : raw ? Date.parse(String(raw)) : NaN;
  if (!ms || Number.isNaN(ms)) return "";
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

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
  const recentLogs = Array.isArray(stats?.recentLogs) ? (stats!.recentLogs as Json[]) : [];
  const activeStepIdx = PIPELINE.indexOf(active);
  const recentProjects = projects.slice(0, 4);

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
              <div className="stat-top">
                <span className="stat-label">{t.statLabels[k]}</span>
                <span className="stat-ic">
                  <Icon name={STAT_ICON[k] || "overview"} />
                </span>
              </div>
              <b className="stat-num">{counts[k] ?? "\u2014"}</b>
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

          <div className="card">
            <div className="card-head">
              <h3>{t.steps.projects.title}</h3>
              <button className="ghost sm" onClick={() => setActive("projects")}>
                {t.manage} <Icon name="project" />
              </button>
            </div>
            {recentProjects.length ? (
              <ul className="recent-projects">
                {recentProjects.map((p) => {
                  const id = String(p.id);
                  const name = String(p.name || "\u2014");
                  const desc = String(p.description || p.repoUrl || "");
                  const connected = !!p.repoUrl;
                  return (
                    <li key={id}>
                      <button type="button" className="rp-row" onClick={() => setActive("projects")}>
                        <span className="rp-ic">
                          <Icon name="project" />
                        </span>
                        <span className="rp-main">
                          <span className="rp-name">{name}</span>
                          {desc ? <span className="rp-desc">{desc}</span> : null}
                        </span>
                        <span className={`pill ${connected ? "pill-ok" : "pill-warn"}`}>
                          <span className="pill-dot" />
                          {connected ? "Connected" : "Draft"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">{t.noEvents}</p>
            )}
          </div>
        </div>

        <aside className="dash-rail">
          <div className="card">
            <div className="card-head">
              <h3>{t.recentTitle}</h3>
            </div>
            {recentLogs.length ? (
              <ul className="activity-list">
                {recentLogs.slice(0, 8).map((l) => {
                  const when = relTime(l);
                  return (
                    <li key={String(l.id)}>
                      <span className="activity-ic">
                        <Icon name="overview" />
                      </span>
                      <div className="activity-main">
                        <span className="activity-msg">{String(l.message)}</span>
                        <span className="activity-meta">
                          <span className="tag">{String(l.type)}</span>
                          {when ? <span className="activity-time">{when}</span> : null}
                        </span>
                      </div>
                    </li>
                  );
                })}
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
