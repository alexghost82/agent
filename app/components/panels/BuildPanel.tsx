"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { downloadMd } from "../../api";
import { downloadZip } from "../../zip";
import { Markdown } from "../../markdown";

type BuildFile = { path: string; content: string };

const STATUS_CLASS: Record<string, string> = {
  running: "in_progress",
  ready: "ready",
  error: "error"
};

function StatusBadge({ status, t }: { status: string; t: any }) {
  const cls = STATUS_CLASS[status] || "todo";
  const label = (t.buildStatus && t.buildStatus[status]) || status;
  return <span className={`status status-${cls}`}>{label}</span>;
}

function FileList({ files, t }: { files: BuildFile[]; t: any }) {
  return (
    <ul className="file-list">
      {files.map((f, i) => (
        <li key={i}>
          <div className="file-head">
            <b>{String(f.path)}</b>
            <button className="ghost sm" onClick={() => downloadMd(String(f.path), String(f.content))}>
              <Icon name="download" /> {t.download}
            </button>
          </div>
          <div className="file-body md-scroll">
            <Markdown>{String(f.content)}</Markdown>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BuildPanel({ g }: { g: GhostData }) {
  const { t, projects, plans, builds, selectedProject, setSelectedProject, loading, output } = g;
  const [planId, setPlanId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [openingId, setOpeningId] = useState("");

  const buildOutput = output.build as any;
  const buildFiles: BuildFile[] = Array.isArray(buildOutput?.files) ? buildOutput.files : [];

  const openOutput = output.buildOpen as any;
  const openRun = openOutput?.run as any;
  const openArtifacts: any[] = Array.isArray(openOutput?.artifacts) ? openOutput.artifacts : [];
  const openFiles: BuildFile[] = openArtifacts.map((a) => ({ path: String(a.path), content: String(a.content) }));

  const projectName =
    String(projects.find((p) => String(p.id) === selectedProject)?.name || "") || "ghost-build";

  return (
    <section className="panel">
      <div className="explain">{t.buildExplain}</div>
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

        <label>{t.selectPlanLabel}</label>
        <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">{t.planOptionNone}</option>
          {plans.map((p) => (
            <option key={String(p.id)} value={String(p.id)}>
              {String(p.title || p.summary || p.id)}
            </option>
          ))}
        </select>

        <label>{t.instructionsLabel}</label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t.ideaPlaceholder}
        />
        <button
          className="primary"
          onClick={() => g.build(selectedProject, planId, instructions)}
          disabled={loading.build || !selectedProject}
        >
          <Icon name="build" /> {loading.build ? t.building : t.buildBtn}
        </button>
      </div>

      {loading.build ? (
        <div className="result-box loading">
          <span className="spinner" /> {t.working}
        </div>
      ) : buildOutput?.error ? (
        <div className="result-box err">
          <strong>{t.errorWord}:</strong>{" "}
          {(t.errorCodes && t.errorCodes[String(buildOutput.error)]) || String(buildOutput.error)}
          {buildOutput.requestId ? (
            <div className="req-id">
              {t.requestId}: <code>{String(buildOutput.requestId)}</code>
            </div>
          ) : null}
        </div>
      ) : buildFiles.length || buildOutput?.summary ? (
        <>
          {buildOutput?.summary ? (
            <div className="result-box">
              <div className="text-block">
                <h4>{t.buildSummary}</h4>
                <Markdown>{String(buildOutput.summary)}</Markdown>
              </div>
            </div>
          ) : null}
          <div className="list-head">
            <h3>
              {t.generatedFiles} ({buildFiles.length})
            </h3>
            {buildFiles.length ? (
              <button className="ghost sm" onClick={() => downloadZip(projectName, buildFiles)}>
                <Icon name="archive" /> {t.downloadZipBtn}
              </button>
            ) : null}
          </div>
          {buildFiles.length ? <FileList files={buildFiles} t={t} /> : null}
        </>
      ) : (
        <div className="result-box empty">{t.noBuildYet}</div>
      )}

      <div className="list-head">
        <h3>{t.pastBuilds}</h3>
        <button className="ghost sm" onClick={() => g.loadBuilds(selectedProject)} disabled={!selectedProject}>
          <Icon name="refresh" /> {t.refreshList}
        </button>
      </div>
      {builds.length ? (
        <ul className="file-list">
          {builds.map((b, i) => {
            const id = String(b.id);
            const isOpen = openingId === id;
            const isOpenLoading = isOpen && loading.buildOpen;
            const showOpened = isOpen && !loading.buildOpen && openRun && String(openRun.id) === id;
            return (
              <li key={id || i}>
                <div className="file-head">
                  <b>{String(b.summary || id)}</b>
                  <span className="row-actions">
                    <StatusBadge status={String(b.status || "")} t={t} />
                    <span className="tag">
                      {String(b.fileCount ?? 0)} {t.buildFilesCount}
                    </span>
                    <button
                      className="ghost sm"
                      onClick={() => {
                        setOpeningId(id);
                        g.openBuild(id);
                      }}
                      disabled={loading.buildOpen}
                    >
                      <Icon name="generate" /> {t.openBuildBtn}
                    </button>
                  </span>
                </div>

                {isOpenLoading ? (
                  <div className="result-box loading">
                    <span className="spinner" /> {t.working}
                  </div>
                ) : showOpened ? (
                  openOutput?.error ? (
                    <div className="result-box err">
                      <strong>{t.errorWord}:</strong>{" "}
                      {(t.errorCodes && t.errorCodes[String(openOutput.error)]) || String(openOutput.error)}
                      {openOutput.requestId ? (
                        <div className="req-id">
                          {t.requestId}: <code>{String(openOutput.requestId)}</code>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <div className="list-head">
                        <h3>
                          {t.generatedFiles} ({openFiles.length})
                        </h3>
                        {openFiles.length ? (
                          <button
                            className="ghost sm"
                            onClick={() =>
                              downloadZip(String(openRun.projectName || projectName), openFiles)
                            }
                          >
                            <Icon name="archive" /> {t.downloadZipBtn}
                          </button>
                        ) : null}
                      </div>
                      {openFiles.length ? <FileList files={openFiles} t={t} /> : null}
                    </>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="result-box empty">{t.noBuildsYet}</div>
      )}
    </section>
  );
}
