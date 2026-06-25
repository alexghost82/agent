"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { downloadMd } from "../../api";
import { downloadZip } from "../../zip";
import { Markdown } from "../../markdown";
import { ResultSkeleton } from "../Skeleton";

type PlanFile = { path: string; content: string };
type PlanPrompt = { title?: string; content: string };

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

export function PlanPanel({ g }: { g: GhostData }) {
  const { t, projects, selectedProject, setSelectedProject, loading, output } = g;
  const [instructions, setInstructions] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const planOutput = output.plan as any;
  const files: PlanFile[] = Array.isArray(planOutput?.files) ? planOutput.files : [];
  const prompts: PlanPrompt[] = Array.isArray(planOutput?.prompts) ? planOutput.prompts : [];

  function exportZip() {
    const entries: PlanFile[] = [
      ...files.map((f) => ({ path: f.path, content: f.content })),
      ...prompts.map((p, i) => ({
        path: `prompts/${(p.title || `prompt-${i + 1}`).replace(/[^\w.-]+/g, "-")}.md`,
        content: p.content
      }))
    ];
    if (entries.length) downloadZip("ghost-plan", entries);
  }

  function copyAllPrompts() {
    const text = prompts
      .map((p, i) => `## ${p.title || `Prompt ${i + 1}`}\n\n${p.content}`)
      .join("\n\n---\n\n");
    navigator.clipboard?.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  }

  return (
    <section className="panel">
      <div className="explain">{t.planExplain}</div>
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
        <label>{t.instructionsLabel}</label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={"Focus on the migration plan\u2026"}
        />
        <button className="primary" onClick={() => g.generatePlan(selectedProject, instructions)} disabled={loading.plan || !selectedProject}>
          <Icon name="generate" /> {loading.plan ? t.generating : t.generate}
        </button>
      </div>

      {loading.plan ? (
        <ResultSkeleton label={t.working} />
      ) : planOutput?.error ? (
        <div className="result-box err">
          <strong>{t.errorWord}:</strong> {(t.errorCodes && t.errorCodes[String(planOutput.error)]) || String(planOutput.error)}
          {planOutput.requestId ? (
            <div className="req-id">
              {t.requestId}: <code>{String(planOutput.requestId)}</code>
            </div>
          ) : null}
        </div>
      ) : files.length || prompts.length ? (
        <>
          {files.length || prompts.length ? (
            <div className="list-head">
              <h3>
                {t.generatedFiles} ({files.length})
              </h3>
              <button className="ghost sm" onClick={exportZip}>
                <Icon name="archive" /> {t.exportAllZip}
              </button>
            </div>
          ) : null}

          {files.length ? (
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
          ) : null}

          {prompts.length ? (
            <>
              <div className="list-head">
                <h3>
                  {t.promptsTitle} ({prompts.length})
                </h3>
                <button className="ghost sm" onClick={copyAllPrompts}>
                  <Icon name="copy" /> {copiedAll ? t.copiedAll : t.copyAll}
                </button>
              </div>
              <ul className="file-list">
                {prompts.map((p, i) => (
                  <li key={i}>
                    <div className="file-head">
                      <b>{String(p.title || `Prompt ${i + 1}`)}</b>
                      <button
                        className="ghost sm"
                        onClick={() => {
                          navigator.clipboard?.writeText(String(p.content));
                          setCopiedIdx(i);
                          setTimeout(() => setCopiedIdx(null), 1500);
                        }}
                      >
                        <Icon name="copy" /> {copiedIdx === i ? t.copied : t.copy}
                      </button>
                    </div>
                    <pre className="file-body">{String(p.content)}</pre>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <div className="result-box empty">{t.noPlanYet}</div>
      )}

      {g.plans.length ? (
        <div className="history-list">
          <div className="list-head">
            <h3>
              {(t as any).planHistoryTitle || "Plan history"} ({g.plans.length})
            </h3>
          </div>
          <ul className="file-list">
            {(g.plans as any[]).map((pl) => {
              const hf: PlanFile[] = Array.isArray(pl.files) ? pl.files : [];
              const hp: PlanPrompt[] = Array.isArray(pl.prompts) ? pl.prompts : [];
              return (
                <li key={String(pl.id)}>
                  <details>
                    <summary className="file-head">
                      <b>{fmtDate(pl.createdAt) || String(pl.projectName || "")}</b>
                      <span className="muted">
                        {hf.length} {t.buildFilesCount} · {hp.length} {t.promptsTitle}
                      </span>
                    </summary>
                    <div className="file-body">
                      {hf.map((f, i) => (
                        <div key={`f${i}`} className="hist-entry">
                          <div className="file-head">
                            <b>{String(f.path)}</b>
                            <button className="ghost sm" onClick={() => downloadMd(String(f.path), String(f.content))}>
                              <Icon name="download" /> {t.download}
                            </button>
                          </div>
                          <div className="md-scroll">
                            <Markdown>{String(f.content)}</Markdown>
                          </div>
                        </div>
                      ))}
                      {hp.map((p, i) => (
                        <div key={`p${i}`} className="hist-entry">
                          <div className="file-head">
                            <b>{String(p.title || `Prompt ${i + 1}`)}</b>
                            <button className="ghost sm" onClick={() => navigator.clipboard?.writeText(String(p.content))}>
                              <Icon name="copy" /> {t.copy}
                            </button>
                          </div>
                          <pre>{String(p.content)}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      ) : selectedProject && !loading.plan ? (
        <div className="result-box empty">{(t as any).noPlanHistory || "No plans saved yet."}</div>
      ) : null}
    </section>
  );
}
