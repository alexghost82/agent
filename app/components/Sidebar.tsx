"use client";

import { useState } from "react";
import { Icon } from "../icons";
import { STEP_KEYS, STEP_META } from "../i18n";
import type { GhostData } from "../useGhostData";

export function Sidebar({ g }: { g: GhostData }) {
  const { t, active, setActive, auth } = g;
  const [menuOpen, setMenuOpen] = useState(false);
  const initial = auth?.username?.charAt(0).toUpperCase() || "?";

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo-box">
          <img src="/ghost-logo.png" alt="GHOST" className="brand-logo" />
        </span>
        <div className="brand-text">
          <strong>
            GHOST
          </strong>
          <span className="brand-sub">AGENT BUILDER</span>
        </div>
      </div>

      <nav className="nav">
        {STEP_KEYS.map((key) => (
          <button
            key={key}
            className={`nav-item ${active === key ? "is-active" : ""}`}
            onClick={() => setActive(key)}
          >
            <span className="nav-ic">
              <Icon name={STEP_META[key].icon} />
            </span>
            <span className="nav-text">{t.steps[key].title}</span>
          </button>
        ))}
      </nav>

      <div className="user-block">
        {menuOpen ? (
          <div className="user-menu" onMouseLeave={() => setMenuOpen(false)}>
            <button className="user-menu-item" onClick={g.logout}>
              <Icon name="logout" /> {t.login.logout}
            </button>
          </div>
        ) : null}
        <button
          className="user-row"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={menuOpen}
        >
          <span className="user-ava">{initial}</span>
          <span className="user-name">
            <span className="user-name-main">{auth?.username}</span>
            <span className="user-plan">{t.proPlan}</span>
          </span>
          <span className={`user-caret ${menuOpen ? "is-open" : ""}`}>
            <Icon name="chevronDown" />
          </span>
        </button>
      </div>
    </aside>
  );
}
