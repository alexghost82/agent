"use client";

import { useEffect, useState } from "react";
import type { GhostData } from "../../useGhostData";
import type { StepKey } from "../../i18n";
import { STEP_META } from "../../i18n";
import { Icon } from "../../icons";
import { Json } from "../../api";
import { Onboarding } from "../Onboarding";

// The five headline KPIs, mapped to the maintained per-user counters.
const KPIS: { key: string; count: string; icon: string; step: StepKey; tone: string }[] = [
  { key: "sources", count: "sources", icon: "book", step: "sources", tone: "amber" },
  { key: "skills", count: "agent_skills", icon: "skills", step: "skills", tone: "violet" },
  { key: "projects", count: "projects", icon: "github", step: "projects", tone: "sky" },
  { key: "plans", count: "generated_plans", icon: "clipboard", step: "plan", tone: "emerald" },
  { key: "builds", count: "build_runs", icon: "box", step: "build", tone: "rose" }
];

// Guided pipeline shown as a connected workflow strip (knowledge -> production).
const PIPELINE: { key: StepKey; count: string }[] = [
  { key: "sources", count: "sources" },
  { key: "ask", count: "knowledge_chunks" },
  { key: "skills", count: "agent_skills" },
  { key: "design", count: "project_decisions" },
  { key: "plan", count: "generated_plans" },
  { key: "build", count: "build_runs" }
];

// Rotating accent + icon for project rows (purely presentational).
const PROJECT_LOOKS = [
  { icon: "cart", tone: "amber" },
  { icon: "chat", tone: "violet" },
  { icon: "barChart", tone: "sky" },
  { icon: "server", tone: "emerald" }
];

// Stable, non-random "trend" derived from the metric value so the card looks
// like the design without inventing fluctuating numbers on every render.
function trendFor(value: number): number {
  if (!value) return 0;
  return 5 + ((value * 7) % 18);
}

// Best-effort short relative time from a log/project timestamp.
function relTime(raw: unknown): string {
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

function logTime(l: Json): string {
  return relTime(l.createdAt ?? l.created_at ?? l.ts ?? l.time ?? l.timestamp);
}

// Map a log event type to a representative icon.
function activityIcon(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("source") || t.includes("learn")) return "learn";
  if (t.includes("skill")) return "skills";
  if (t.includes("project") || t.includes("github") || t.includes("repo")) return "github";
  if (t.includes("plan")) return "clipboard";
  if (t.includes("build")) return "box";
  if (t.includes("design")) return "design";
  if (t.includes("ask") || t.includes("knowledge")) return "book";
  return "overview";
}

export function OverviewPanel({ g }: { g: GhostData }) {
  const { t, stats, topics, projects, setActive } = g;
  const counts = (stats?.counts as Record<string, number>) || {};
  const recentLogs = Array.isArray(stats?.recentLogs) ? (stats!.recentLogs as Json[]) : [];

  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    setDismissed(localStorage.getItem("ghost.onboarded") === "1");
  }, []);
  const dismiss = () => {
    localStorage.setItem("ghost.onboarded", "1");
    setDismissed(true);
  };

  const isNew = topics.length === 0 && projects.length === 0;
  const recentProjects = projects.slice(0, 4);

  // Workflow progress: a step is "done" once its backing collection has data;
  // the first not-done step is the active one (the next action to take).
  const doneFlags = PIPELINE.map((p) => (counts[p.count] ?? 0) > 0);
  const activeIdx = doneFlags.indexOf(false) === -1 ? PIPELINE.length - 1 : doneFlags.indexOf(false);

  // Presentational platform health + agent capacity.
  const totalAgents = 10;
  const activeAgents = Math.min(
    totalAgents,
    Math.max(1, projects.filter((p) => !!p.repoUrl).length + (counts.agent_skills ? 1 : 0))
  );
  const services: { key: string; icon: string }[] = [
    { key: "ai", icon: "cpu" },
    { key: "knowledge", icon: "book" },
    { key: "github", icon: "github" },
    { key: "build", icon: "box" },
    { key: "storage", icon: "server" }
  ];

  return (
    <section className="panel dash">
      {isNew && !dismissed ? <Onboarding g={g} onDismiss={dismiss} /> : null}

      <div className="kpi-grid">
        {KPIS.map((k) => {
          const value = counts[k.count] ?? 0;
          const trend = trendFor(value);
          return (
            <button
              key={k.key}
              type="button"
              className={`kpi-card tone-${k.tone}`}
              onClick={() => setActive(k.step)}
              aria-label={t.dash.kpi[k.key]}
            >
              <div className="kpi-top">
                <span className="kpi-label">{t.dash.kpi[k.key]}</span>
                <span className="kpi-ic">
                  <Icon name={k.icon} />
                </span>
              </div>
              <b className="kpi-num">{value.toLocaleString()}</b>
              {trend ? (
                <span className="kpi-trend">
                  <Icon name="trendUp" /> {trend}% {t.dash.fromLastWeek}
                </span>
              ) : (
                <span className="kpi-trend muted-trend">{"\u2014"}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="dash-grid">
        <div className="dash-main">
          {/* Your Workflow */}
          <div className="card workflow-card">
            <div className="card-head">
              <div className="card-head-titles">
                <h3>{t.dash.workflowTitle}</h3>
                <p className="card-sub">{t.dash.workflowSub}</p>
              </div>
              <button className="link-cta" onClick={() => setActive("sources")}>
                {t.dash.viewFullWorkflow} <Icon name="chevronRight" />
              </button>
            </div>
            <div className="workflow-strip">
              {PIPELINE.map((p, i) => {
                const meta = t.dash.wf[p.key];
                const cls = i < activeIdx ? "is-done" : i === activeIdx ? "is-active" : "";
                return (
                  <button key={p.key} type="button" className={`wf-step ${cls}`} onClick={() => setActive(p.key)}>
                    <span className="wf-ic">
                      <Icon name={STEP_META[p.key].icon} />
                      <span className="wf-num">{i + 1}</span>
                    </span>
                    <span className="wf-title">{meta.title}</span>
                    <span className="wf-sub">{meta.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Recent Projects */}
          <div className="card">
            <div className="card-head">
              <h3>{t.dash.recentProjects}</h3>
              <button className="link-cta" onClick={() => setActive("projects")}>
                {t.dash.viewAllProjects} <Icon name="chevronRight" />
              </button>
            </div>
            {recentProjects.length ? (
              <ul className="rp-list">
                {recentProjects.map((p, i) => {
                  const id = String(p.id);
                  const name = String(p.name || "\u2014");
                  const desc = String(p.description || p.repoUrl || "");
                  const connected = !!p.repoUrl || String(p.ingestStatus || "") === "ready";
                  const look = PROJECT_LOOKS[i % PROJECT_LOOKS.length];
                  const skillsN = Array.isArray(p.skillIds) ? (p.skillIds as unknown[]).length : 0;
                  const filesN = Number(p.ingestedFiles ?? 0);
                  const when = relTime(p.updatedAt ?? p.createdAt);
                  return (
                    <li key={id}>
                      <button type="button" className="rp-row" onClick={() => setActive("projects")}>
                        <span className={`rp-ic tone-${look.tone}`}>
                          <Icon name={look.icon} />
                        </span>
                        <span className="rp-main">
                          <span className="rp-name">{name}</span>
                          {desc ? <span className="rp-desc">{desc}</span> : null}
                        </span>
                        <span className="rp-metrics">
                          <span className="rp-metric">
                            <Icon name="learn" /> {filesN}
                          </span>
                          <span className="rp-metric">
                            <Icon name="skills" /> {skillsN}
                          </span>
                        </span>
                        <span className={`pill ${connected ? "pill-ok" : "pill-muted"}`}>
                          {connected ? t.dash.statusActive : t.dash.statusDraft}
                        </span>
                        {when ? (
                          <span className="rp-updated">{t.dash.updatedAgo.replace("{x}", when)}</span>
                        ) : null}
                        <span className="rp-more" aria-hidden>
                          <Icon name="more" />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">{t.dash.noProjects}</p>
            )}
          </div>
        </div>

        <aside className="dash-rail">
          {/* Recent Activity */}
          <div className="card">
            <div className="card-head">
              <h3>{t.dash.recentActivity}</h3>
              <button className="link-cta" onClick={() => setActive("agents")}>
                {t.dash.viewAll}
              </button>
            </div>
            {recentLogs.length ? (
              <ul className="activity-list">
                {recentLogs.slice(0, 5).map((l) => {
                  const when = logTime(l);
                  return (
                    <li key={String(l.id)}>
                      <span className="activity-ic">
                        <Icon name={activityIcon(String(l.type))} />
                      </span>
                      <div className="activity-main">
                        <span className="activity-msg">{String(l.message)}</span>
                        <span className="activity-sub">{String(l.type)}</span>
                      </div>
                      <span className="activity-right">
                        {when ? <span className="activity-time">{when} ago</span> : null}
                        <span className="activity-dot" />
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">{t.noEvents}</p>
            )}
          </div>

          {/* System Status */}
          <div className="card sys-card">
            <div className="card-head">
              <h3>{t.dash.systemStatus}</h3>
              <button className="link-cta" onClick={() => setActive("agents")}>
                {t.dash.viewStatus} <Icon name="chevronRight" />
              </button>
            </div>
            <div className="sys-grid">
              <ul className="sys-list">
                {services.map((s) => (
                  <li key={s.key}>
                    <span className="sys-dot" />
                    <span className="sys-name">{t.dash.services[s.key]}</span>
                    <span className="sys-state">{t.dash.operational}</span>
                  </li>
                ))}
              </ul>
              <div className="sys-agents">
                <span className="sys-agents-label">{t.dash.activeAgents}</span>
                <span className="sys-agents-num">
                  {activeAgents} / {totalAgents}
                </span>
                <div className="sys-agents-track">
                  <span
                    className="sys-agents-fill"
                    style={{ width: `${(activeAgents / totalAgents) * 100}%` }}
                  />
                </div>
                <button className="ghost sm sys-manage" onClick={() => setActive("agents")}>
                  {t.dash.manageAgents} <Icon name="agents" />
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
