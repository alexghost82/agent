"use client";

import { Icon } from "../icons";
import { STEP_KEYS, STEP_META } from "../i18n";
import type { GhostData } from "../useGhostData";

const MEMORY_CAP = 1500;

export function Sidebar({ g }: { g: GhostData }) {
  const { t, active, setActive, auth, stats } = g;
  const counts = (stats?.counts as Record<string, number>) || {};
  const chunks = counts.knowledge_chunks ?? 0;
  const memPct = Math.min(100, Math.round((chunks / MEMORY_CAP) * 100));

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo-box">
          <img src="/ghost-logo.png" alt="GHOST" className="brand-logo" />
        </span>
        <div className="brand-text">
          <strong>
            GHOST <span className="brand-accent">Agent Builder</span>
          </strong>
          <span className="brand-sub">{t.brandSub}</span>
        </div>
      </div>

      <nav className="nav">
        {STEP_KEYS.map((key) => (
          <button key={key} className={`nav-item ${active === key ? "is-active" : ""}`} onClick={() => setActive(key)}>
            <span className="nav-ic">
              <Icon name={STEP_META[key].icon} />
            </span>
            <span className="nav-text">{t.steps[key].title}</span>
          </button>
        ))}
      </nav>

      <div className="usage-card">
        <div className="usage-top">
          <span className="usage-label">{t.memoryLabel}</span>
          <span className="usage-pct">{memPct}%</span>
        </div>
        <div className="usage-val">
          {chunks.toLocaleString()} / {MEMORY_CAP.toLocaleString()} {t.memoryUnit}
        </div>
        <div className="usage-track">
          <span className="usage-fill" style={{ width: `${memPct}%` }} />
        </div>
        <button className="usage-btn" onClick={() => setActive("sources")}>
          <Icon name="learn" /> {t.manage}
        </button>
      </div>

      <div className="user-row">
        <span className="user-ava">{auth?.username.charAt(0).toUpperCase()}</span>
        <span className="user-name">{auth?.username}</span>
        <button className="logout" onClick={g.logout} title={t.login.logout} aria-label={t.login.logout}>
          <Icon name="logout" />
        </button>
      </div>
    </aside>
  );
}
