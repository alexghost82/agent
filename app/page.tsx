"use client";

import "./styles.css";
import { STEP_META } from "./i18n";
import { Icon } from "./icons";
import { useGhostData } from "./useGhostData";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { OverviewPanel } from "./components/panels/OverviewPanel";
import { SourcesPanel } from "./components/panels/SourcesPanel";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { ProjectsPanel } from "./components/panels/ProjectsPanel";
import { AskPanel } from "./components/panels/AskPanel";
import { DesignPanel } from "./components/panels/DesignPanel";
import { PlanPanel } from "./components/panels/PlanPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";

export default function Home() {
  const g = useGhostData();
  const { t, rtl, active } = g;

  if (!g.authReady) return null;
  if (!g.auth) return <Login g={g} />;

  const meta = STEP_META[active];

  return (
    <div className={`app ${rtl ? "rtl" : ""}`}>
      <Sidebar g={g} />

      <main className="content">
        <header className="page-head">
          <div>
            <p className="crumb">
              {t.step} {meta.n === "\u2022" ? "\u2014" : meta.n}
            </p>
            <h1>{t.steps[active].title}</h1>
            <p className="page-hint">{t.steps[active].hint}</p>
          </div>
          <button className="ghost" onClick={g.refreshAll}>
            <Icon name="refresh" /> {t.refresh}
          </button>
        </header>

        {active === "overview" && <OverviewPanel g={g} />}
        {active === "sources" && <SourcesPanel g={g} />}
        {active === "skills" && <SkillsPanel g={g} />}
        {active === "projects" && <ProjectsPanel g={g} />}
        {active === "ask" && <AskPanel g={g} />}
        {active === "design" && <DesignPanel g={g} />}
        {active === "plan" && <PlanPanel g={g} />}
        {active === "settings" && <SettingsPanel g={g} />}
      </main>
    </div>
  );
}
