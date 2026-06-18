"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { downloadMd } from "../../api";
import { downloadZip } from "../../zip";
import { Markdown } from "../../markdown";

type PlanFile = { path: string; content: string };
type PlanPrompt = { title?: string; content: string };

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
        <div className="result-box loading">
          <span className="spinner" /> {t.working}
        </div>
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
    </section>
  );
}
