"use client";

import "./styles.css";
import { useGhostData } from "./useGhostData";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { OverviewPanel } from "./components/panels/OverviewPanel";
import { SourcesPanel } from "./components/panels/SourcesPanel";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { ProjectsPanel } from "./components/panels/ProjectsPanel";
import { AskPanel } from "./components/panels/AskPanel";
import { DesignPanel } from "./components/panels/DesignPanel";
import { PlanPanel } from "./components/panels/PlanPanel";
import { BuildPanel } from "./components/panels/BuildPanel";
import { AgentPanel } from "./components/panels/AgentPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";

export default function Home() {
  const g = useGhostData();
  const { rtl, active } = g;

  if (!g.authReady) return null;
  if (!g.auth) return <Login g={g} />;

  return (
    <div className={`app ${rtl ? "rtl" : ""}`}>
      <Sidebar g={g} />

      <main className="content">
        <Topbar g={g} />

        {active === "overview" && <OverviewPanel g={g} />}
        {active === "sources" && <SourcesPanel g={g} />}
        {active === "skills" && <SkillsPanel g={g} />}
        {active === "projects" && <ProjectsPanel g={g} />}
        {active === "ask" && <AskPanel g={g} />}
        {active === "design" && <DesignPanel g={g} />}
        {active === "plan" && <PlanPanel g={g} />}
        {active === "build" && <BuildPanel g={g} />}
        {active === "agents" && <AgentPanel g={g} />}
        {active === "settings" && <SettingsPanel g={g} />}
      </main>
    </div>
  );
}
