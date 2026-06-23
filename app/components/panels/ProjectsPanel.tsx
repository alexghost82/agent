"use client";

import { useMemo, useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Json } from "../../api";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { Pagination, usePaged } from "../Pagination";
import { ProjectMapModal } from "../ProjectMapModal";
import { Markdown } from "../../markdown";

function IngestProgress({ p, t }: { p: Json; t: any }) {
  const done = Number(p.ingestedFiles ?? 0);
  const total = Number(p.ingestTotalFiles ?? p.totalFiles ?? p.ingestTotal ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="ingest-progress">
      <div className="ingest-row">
        <span className="spinner" />
        <span>
          {t.ingestProgress} {"\u2014"} {done}
          {total > 0 ? ` / ${total}` : ""} {t.filesSoFar}
        </span>
      </div>
      <div className="progress-track">
        <div className={`progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ProjectsPanel({ g }: { g: GhostData }) {
  const { t, projects, skills, selectedProject, setSelectedProject, selectedSkillIds, loading, output, query } = g;

  const [createMode, setCreateMode] = useState<"scratch" | "repo">("scratch");
  const [pName, setPName] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pStack, setPStack] = useState("");
  const [pRepo, setPRepo] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [tokenMsg, setTokenMsg] = useState("");

  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [eStack, setEStack] = useState("");
  const [eRepo, setERepo] = useState("");

  const [skillSearch, setSkillSearch] = useState("");

  // Project Intelligence map (scan-driven).
  const [intelProject, setIntelProject] = useState<{ id: string; name: string } | null>(null);

  // Which project summaries are expanded (per project id).
  const [openSummaries, setOpenSummaries] = useState<Set<string>>(new Set());
  const toggleSummary = (id: string) =>
    setOpenSummaries((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Filter the project list by the global top-bar search.
  const q = (query || "").trim().toLowerCase();
  const filteredProjects = useMemo(
    () =>
      q
        ? projects.filter((p) =>
            `${String(p.name || "")} ${String(p.description || "")} ${String(p.repoUrl || "")}`
              .toLowerCase()
              .includes(q)
          )
        : projects,
    [projects, q]
  );

  const { page, setPage, pageCount, visible } = usePaged(filteredProjects, 6);

  async function createProject() {
    await g.createProject({
      name: pName.trim(),
      description: pDesc.trim(),
      stack: pStack.trim() || undefined,
      // From-scratch projects never carry a repo URL; the agent builds on the
      // description + learned knowledge/skills instead.
      repoUrl: createMode === "repo" ? pRepo.trim() || undefined : undefined
    });
    setPName("");
    setPDesc("");
    setPStack("");
    setPRepo("");
  }

  async function saveGithubToken() {
    if (!ghToken.trim()) return;
    setTokenMsg("");
    try {
      await g.saveGithubToken(ghToken);
      setGhToken("");
      setTokenMsg(t.tokenSaved);
    } catch {
      setTokenMsg(t.requestFailed);
    }
  }

  function startEdit(p: Json) {
    setEditId(String(p.id));
    setEName(String(p.name || ""));
    setEDesc(String(p.description || ""));
    setEStack(String(p.stack || ""));
    setERepo(String(p.repoUrl || ""));
  }
  async function saveEdit(id: string) {
    await g.updateProject(id, {
      name: eName.trim(),
      description: eDesc.trim(),
      stack: eStack.trim() || undefined,
      repoUrl: eRepo.trim() || undefined
    });
    setEditId(null);
  }

  const filteredSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      `${s.skillName ?? ""} ${s.description ?? ""}`.toLowerCase().includes(q)
    );
  }, [skills, skillSearch]);

  function selectAllVisible() {
    const ids = filteredSkills.map((s) => String(s.id));
    g.setSelectedSkillIds(Array.from(new Set([...selectedSkillIds, ...ids])));
  }
  function clearSelection() {
    g.setSelectedSkillIds([]);
  }

  return (
    <section className="panel">
      <div className="explain">{t.projectExplain}</div>

      <div className="form-card">
        <div className="seg create-mode-seg">
          <button
            type="button"
            className={createMode === "scratch" ? "on" : ""}
            onClick={() => setCreateMode("scratch")}
          >
            {t.createScratchTab}
          </button>
          <button
            type="button"
            className={createMode === "repo" ? "on" : ""}
            onClick={() => setCreateMode("repo")}
          >
            {t.createRepoTab}
          </button>
        </div>
        <p className="muted url-hint">{createMode === "scratch" ? t.createScratchHint : t.repoModeHint}</p>
        <div className="form-row">
          <div>
            <label>{t.nameLabel}</label>
            <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="My SaaS" />
          </div>
          <div>
            <label>{t.stackLabel}</label>
            <input value={pStack} onChange={(e) => setPStack(e.target.value)} placeholder="Next.js, Firebase" />
          </div>
        </div>
        <label>{t.descLabel}</label>
        <textarea value={pDesc} onChange={(e) => setPDesc(e.target.value)} placeholder="What the project does" />
        {createMode === "repo" ? (
          <>
            <label>{t.repoLabel}</label>
            <input value={pRepo} onChange={(e) => setPRepo(e.target.value)} placeholder="https://github.com/you/repo" />
          </>
        ) : null}
        <button
          className="primary"
          onClick={createProject}
          disabled={loading.projectCreate || pName.trim().length < 2 || pDesc.trim().length < 5}
        >
          <Icon name="plus" /> {createMode === "scratch" ? t.createScratch : t.createProject}
        </button>
      </div>

      <div className="form-card">
        <h3 className="card-title">{t.githubSection}</h3>
        <label>{t.githubTokenLabel}</label>
        <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={"ghp_\u2026"} autoComplete="off" />
        <button className="ghost sm" onClick={saveGithubToken} disabled={!ghToken.trim()}>
          <Icon name="github" /> {t.saveToken}
        </button>
        {tokenMsg ? <span className="badge-line">{tokenMsg}</span> : null}
      </div>

      {projects.length ? (
        <>
          <div className="list-head">
            <h3>
              {t.steps.projects.title} ({filteredProjects.length})
            </h3>
          </div>
          {!filteredProjects.length ? <p className="muted">{t.searchEmpty}</p> : null}
          <ul className="task-list">
            {visible.map((p) => {
              const id = String(p.id);
              const status = String(p.ingestStatus || "none");
              const repoUrl = String(p.repoUrl || "");
              const ghKey = `gh-${id}`;
              const ghOutput = output[ghKey];
              const delKey = `del-project-${id}`;
              const editKey = `edit-project-${id}`;
              const ghError = ghOutput?.error ? String(ghOutput.error) : "";
              const ghRequestId = ghOutput?.requestId ? String(ghOutput.requestId) : "";
              const mapStatus = String(p.mapStatus || "none");
              const mapBuilding = ["queued", "building"].includes(mapStatus);

              if (editId === id) {
                return (
                  <li key={id} className="proj-item">
                    <div style={{ width: "100%" }}>
                      <label>{t.nameLabel}</label>
                      <input value={eName} onChange={(e) => setEName(e.target.value)} />
                      <div className="form-row">
                        <div>
                          <label>{t.stackLabel}</label>
                          <input value={eStack} onChange={(e) => setEStack(e.target.value)} />
                        </div>
                        <div>
                          <label>{t.repoLabel}</label>
                          <input value={eRepo} onChange={(e) => setERepo(e.target.value)} />
                        </div>
                      </div>
                      <label>{t.descLabel}</label>
                      <textarea value={eDesc} onChange={(e) => setEDesc(e.target.value)} />
                      <div className="row-actions" style={{ marginTop: 12 }}>
                        <button className="primary sm-primary" onClick={() => saveEdit(id)} disabled={!!loading[editKey] || eName.trim().length < 2}>
                          {loading[editKey] ? t.saving : t.save}
                        </button>
                        <button className="ghost sm" onClick={() => setEditId(null)}>
                          {t.cancel}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              }

              return (
                <li key={id} className="proj-item">
                  <div className="task-main">
                    <b>{String(p.name)}</b>
                    <span>
                      {repoUrl || "\u2014"} {"\u00b7"} {Number(p.ingestedFiles ?? 0)} {t.filesIndexed}
                    </span>
                    {p.summary ? (
                      <div className="proj-summary">
                        <div className={`proj-summary-body ${openSummaries.has(id) ? "open" : "clamp"}`}>
                          <Markdown>{String(p.summary)}</Markdown>
                        </div>
                        {String(p.summary).length > 320 ? (
                          <button type="button" className="link-btn read-more" onClick={() => toggleSummary(id)}>
                            {openSummaries.has(id) ? t.showLess || "Show less" : t.readMore || "Read more"}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {ghError ? (
                      <p className="appr-review inline-error">
                        <strong>{t.errorWord}:</strong> {(t.errorCodes && t.errorCodes[ghError]) || ghError}
                        {ghRequestId ? (
                          <span className="req-id">
                            {t.requestId}: <code>{ghRequestId}</code>
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                    {status === "ingesting" ? <IngestProgress p={p} t={t} /> : null}
                    {status === "error" && p.ingestError ? (
                      <p className="appr-review inline-error">
                        <strong>{t.errorWord}:</strong> {String(p.ingestError)}
                      </p>
                    ) : null}
                    {mapStatus !== "none" ? (
                      <span className={`scan-status map-status map-${mapStatus}`}>
                        {mapBuilding ? <span className="spinner" /> : null}
                        {t.mapStatus || "Map"}:{" "}
                        {mapStatus === "ready"
                          ? `${t.mapReady || "ready"} \u00b7 ${Number(p.mapNodeCount ?? 0)} ${t.nodes || "nodes"} \u00b7 ${Number(p.mapEdgeCount ?? 0)} ${t.edges || "edges"}`
                          : mapStatus === "error"
                            ? t.mapError || "error"
                            : t.mapBuilding || "building\u2026"}
                      </span>
                    ) : null}
                    {mapStatus === "error" && p.mapError ? (
                      <p className="appr-review inline-error">
                        <strong>{t.errorWord}:</strong> {String(p.mapError)}
                      </p>
                    ) : null}
                  </div>
                  <div className="proj-footer">
                    <span className={`status status-${status}`}>{t[`ingest_${status}`] || status}</span>
                    <div className="row-actions">
                    <button
                      className="ghost sm"
                      onClick={() => g.connectGithub(id, repoUrl)}
                      disabled={!repoUrl || !!loading[ghKey]}
                    >
                      <Icon name="github" /> {loading[ghKey] ? t.connecting : t.connectGithub}
                    </button>
                    <button
                      className="ghost sm"
                      onClick={() => g.startScan(id, { ai: true })}
                      disabled={!repoUrl || !!loading[`scan-${id}`]}
                      title={!repoUrl ? t.scanMapHint || t.scanNeedsRepo || "Connect a repository first" : undefined}
                      aria-label={t.buildMap || "Build map"}
                    >
                      <Icon name="search" /> {loading[`scan-${id}`] ? t.mapBuilding || "Building\u2026" : mapStatus === "ready" ? t.rescanBtn || "Rebuild map" : t.buildMap || "Build map"}
                    </button>
                    <button
                      className="ghost sm"
                      onClick={() => setIntelProject({ id, name: String(p.name) })}
                      disabled={!repoUrl}
                      aria-label={t.openMap || "Open map"}
                    >
                      <Icon name="overview" /> {t.openMap || "Open map"}
                    </button>
                    <button className="ghost sm" onClick={() => startEdit(p)} aria-label={t.edit}>
                      <Icon name="edit" /> {t.edit}
                    </button>
                    <button
                      className="ghost sm danger-btn"
                      onClick={() => {
                        if (confirm(t.confirmDelete)) g.deleteProject(id);
                      }}
                      disabled={!!loading[delKey]}
                      aria-label={t.delete}
                    >
                      <Icon name="trash" />
                    </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <Pagination page={page} pageCount={pageCount} setPage={setPage} t={t} />
        </>
      ) : (
        <p className="muted">{t.noProjects}</p>
      )}

      <div className="form-card">
        <label>{t.selectProject}</label>
        <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">{"\u2014"}</option>
          {projects.map((p) => (
            <option key={String(p.id)} value={String(p.id)}>
              {String(p.name)}
            </option>
          ))}
        </select>
        {selectedProject ? (
          <>
            <div className="skills-toolbar">
              <label style={{ margin: 0 }}>{t.skillsToUse}</label>
              <div className="skills-tools">
                <div className="search-box">
                  <Icon name="search" />
                  <input
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder={t.searchSkills}
                    aria-label={t.searchSkills}
                  />
                </div>
                <button className="ghost sm" onClick={selectAllVisible} disabled={!filteredSkills.length}>
                  <Icon name="check" /> {t.selectAll}
                </button>
                <button className="ghost sm" onClick={clearSelection} disabled={!selectedSkillIds.length}>
                  {t.clearSel}
                </button>
              </div>
            </div>
            {skills.length ? (
              filteredSkills.length ? (
                <div className="skill-pick">
                  {filteredSkills.map((s) => (
                    <label key={String(s.id)} className="check">
                      <input
                        type="checkbox"
                        checked={selectedSkillIds.includes(String(s.id))}
                        onChange={() => g.toggleSkill(String(s.id))}
                      />
                      <span>{String(s.skillName)}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="muted">{t.noMatches}</p>
              )
            ) : (
              <p className="muted">{t.noSkillsYet}</p>
            )}
            <button
              className="primary"
              onClick={() => g.saveProjectSkills(selectedProject, selectedSkillIds)}
              disabled={loading.saveSkills}
            >
              {t.saveSkills}
            </button>
            {(output.saveSkills as any)?.saved ? <span className="badge-line">{t.skillsSaved}</span> : null}
          </>
        ) : null}
      </div>
      <ResultView k="projectCreate" output={output} loading={loading} t={t} />

      {intelProject ? (
        <ProjectMapModal
          g={g}
          projectId={intelProject.id}
          projectName={intelProject.name}
          onClose={() => setIntelProject(null)}
        />
      ) : null}
    </section>
  );
}
