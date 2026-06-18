"use client";

import { Icon } from "../icons";
import { STEP_KEYS, STEP_META } from "../i18n";
import type { GhostData } from "../useGhostData";

export function Sidebar({ g }: { g: GhostData }) {
  const { t, lang, setLang, theme, setTheme, active, setActive, auth, stats } = g;
  const counts = (stats?.counts as Record<string, number>) || {};

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/ghost-logo.png" alt="GHOST" className="brand-logo" />
        <div>
          <strong>GHOST Agent Builder</strong>
          <span className="brand-sub">{t.brandSub}</span>
        </div>
      </div>

      <div className="switchers">
        <div className="seg">
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
            EN
          </button>
          <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>
            HEB
          </button>
          <button className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>
            RU
          </button>
        </div>
        <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="theme">
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </div>

      <p className="nav-label">{t.workflow}</p>
      <nav className="nav">
        {STEP_KEYS.map((key) => (
          <button key={key} className={`nav-item ${active === key ? "is-active" : ""}`} onClick={() => setActive(key)}>
            <span className="nav-num">{STEP_META[key].n}</span>
            <span className="nav-ic">
              <Icon name={STEP_META[key].icon} />
            </span>
            <span className="nav-text">{t.steps[key].title}</span>
          </button>
        ))}
      </nav>

      <div className="mini-stats">
        <div>
          <b>{counts.sources ?? "\u2014"}</b>
          <span>{t.miniSources}</span>
        </div>
        <div>
          <b>{counts.agent_skills ?? "\u2014"}</b>
          <span>{t.miniSkills}</span>
        </div>
        <div>
          <b>{counts.projects ?? "\u2014"}</b>
          <span>{t.miniProjects}</span>
        </div>
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
