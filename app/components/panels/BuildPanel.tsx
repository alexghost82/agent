"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { downloadMd } from "../../api";
import { downloadZip } from "../../zip";
import { Markdown } from "../../markdown";
import { ResultSkeleton } from "../Skeleton";

type BuildFile = { path: string; content: string };

// Format a stored timestamp (Firestore admin serializes to { _seconds, … },
// but it may also arrive as a number or ISO string) into a readable date.
function fmtDate(raw: any): string {
  let ms = NaN;
  if (typeof raw === "number") ms = raw;
  else if (typeof raw === "string") ms = Date.parse(raw);
  else if (raw && typeof raw === "object") {
    const s = raw._seconds ?? raw.seconds;
    if (typeof s === "number") ms = s * 1000;
  }
  return Number.isNaN(ms) ? "" : new Date(ms).toLocaleString();
}

// Human-readable label for a saved plan in the picker. Plan docs have no title,
// so we build one from the date, file count and the first prompt title / file
// name — never the raw document id.
function planLabel(p: any, t: any): string {
  const files: any[] = Array.isArray(p.files) ? p.files : [];
  const prompts: any[] = Array.isArray(p.prompts) ? p.prompts : [];
  const hint = String(prompts.find((x) => x?.title)?.title || files[0]?.path || "").trim();
  const parts: string[] = [];
  const date = fmtDate(p.createdAt);
  if (date) parts.push(date);
  parts.push(`${files.length} ${t.buildFilesCount}`);
  let label = parts.join(" \u00b7 ");
  if (hint) label += ` \u2014 ${hint}`;
  return label || String(p.id);
}

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

const VERIFY_CLASS: Record<string, string> = {
  passed: "ready",
  failed: "error",
  error: "error",
  skipped: "todo"
};

// Shows the build verification result (passed/failed/skipped/error) plus a
// draft/verified mark. Additive — renders nothing for older runs without a
// verification report.
function VerificationBadge({ verification, t }: { verification: any; t: any }) {
  if (!verification || !verification.status) return null;
  const status = String(verification.status);
  const cls = VERIFY_CLASS[status] || "todo";
  const statusLabel = (t.verifyStatus && t.verifyStatus[status]) || status;
  const mark = status === "passed" ? t.buildVerified : t.buildDraft;
  return (
    <span className="row-actions">
      <span className={`status status-${cls}`}>
        {t.verifyTitle}: {statusLabel}
      </span>
      <span className="tag">{mark}</span>
    </span>
  );
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
              {planLabel(p, t)}
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
        <ResultSkeleton label={t.working} />
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
            <span className="row-actions">
              <VerificationBadge verification={buildOutput?.verification} t={t} />
              {buildFiles.length ? (
                <button className="ghost sm" onClick={() => downloadZip(projectName, buildFiles)}>
                  <Icon name="archive" /> {t.downloadZipBtn}
                </button>
              ) : null}
            </span>
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
                  <b>{String(b.summary || `${b.projectName || ""} ${fmtDate(b.createdAt)}`.trim() || id)}</b>
                  <span className="row-actions">
                    <StatusBadge status={String(b.status || "")} t={t} />
                    <VerificationBadge verification={(b as any).verification} t={t} />
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
                  <ResultSkeleton label={t.working} />
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
                        <span className="row-actions">
                          <VerificationBadge verification={openRun?.verification} t={t} />
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
                        </span>
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
