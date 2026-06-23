"use client";

import { useState } from "react";
import { Icon } from "../icons";
import { STEP_META } from "../i18n";
import type { GhostData } from "../useGhostData";
import type { Json } from "../api";

export function Topbar({ g }: { g: GhostData }) {
  const { t, lang, setLang, theme, setTheme, active, query, setQuery, setActive } = g;
  const meta = STEP_META[active];
  const stepN = meta.n === "\u2022" ? "\u2014" : meta.n;

  const recent = Array.isArray(g.stats?.recentLogs) ? (g.stats!.recentLogs as Json[]) : [];
  const [bellOpen, setBellOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="topbar-titles">
        <p className="crumb">
          {t.step} {stepN}
        </p>
        <h1>{t.steps[active].title}</h1>
        <p className="page-hint">{t.steps[active].hint}</p>
      </div>

      <div className="topbar-tools">
        <div className="topbar-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchPlaceholder}
          />
          {query ? (
            <button className="search-clear" onClick={() => setQuery("")} aria-label="clear">
              {"\u00d7"}
            </button>
          ) : (
            <kbd className="search-kbd">{"\u2318K"}</kbd>
          )}
        </div>

        <div className="topbar-bell">
          <button
            className={`icon-btn ${recent.length ? "has-dot" : ""}`}
            onClick={() => setBellOpen((v) => !v)}
            aria-label={t.notifications}
            title={t.notifications}
          >
            <Icon name="bell" />
          </button>
          {bellOpen ? (
            <div className="bell-pop" onMouseLeave={() => setBellOpen(false)}>
              <div className="bell-pop-head">{t.notifications}</div>
              {recent.length ? (
                <ul>
                  {recent.slice(0, 6).map((l) => (
                    <li
                      key={String(l.id)}
                      onClick={() => {
                        setActive("overview");
                        setBellOpen(false);
                      }}
                    >
                      <span className="tag">{String(l.type)}</span>
                      <span className="bell-msg">{String(l.message)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted bell-empty">{t.noNotifications}</p>
              )}
            </div>
          ) : null}
        </div>

        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="theme"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>

        <div className="seg topbar-seg">
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
            EN
          </button>
          <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>
            HE
          </button>
          <button className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>
            RU
          </button>
        </div>

        <button className="ghost topbar-refresh" onClick={g.refreshAll}>
          <Icon name="refresh" /> <span>{t.refresh}</span>
        </button>
      </div>
    </header>
  );
}
