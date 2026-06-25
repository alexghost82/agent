"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { downloadZip } from "../../zip";
import { Markdown } from "../../markdown";
import { ResultSkeleton } from "../Skeleton";
import { ProcessTracker } from "../ProcessTracker";

type BuildFile = { path: string; content: string };

const VERIFY_CLASS: Record<string, string> = {
  passed: "ready",
  failed: "error",
  error: "error",
  skipped: "todo"
};

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

// Full-autopilot panel: a list of resource URLs + a task description drive the
// whole learn → skills → design → plan → verified build cycle in one call, with
// live progress steps and the resulting verified build files.
export function AgentPanel({ g }: { g: GhostData }) {
  const { t, loading, output } = g;
  const [urls, setUrls] = useState("");
  const [task, setTask] = useState("");
  const [deep, setDeep] = useState(false);

  const result = output.agent as any;
  const isError = result?.error;
  const steps: { name: string; status: string; detail?: string }[] = Array.isArray(result?.steps) ? result.steps : [];
  const files: BuildFile[] = Array.isArray(result?.files) ? result.files : [];
  const urlList = urls.split("\n").map((u) => u.trim()).filter(Boolean);

  return (
    <section className="panel">
      <div className="explain">{t.agentExplain}</div>
      <div className="form-card">
        <label>{t.agentUrlsLabel}</label>
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder={"https://example.com/docs\nhttps://example.com/guide"}
          rows={4}
        />

        <label>{t.agentTaskLabel}</label>
        <textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder={t.agentTaskPlaceholder} />

        <label className="check">
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          <span>{t.agentDeepLabel}</span>
        </label>

        <button
          className="primary"
          onClick={() => g.runAgent(urlList, task, deep)}
          disabled={loading.agent || !urlList.length || task.trim().length < 3}
        >
          <Icon name="generate" /> {loading.agent ? t.agentRunning : t.agentRunBtn}
        </button>
      </div>

      {loading.agent ? (
        g.agentRun ? (
          <ProcessTracker run={g.agentRun} t={t} />
        ) : (
          <ResultSkeleton label={t.agentRunning} />
        )
      ) : isError ? (
        <div className="result-box err">
          <strong>{t.errorWord}:</strong>{" "}
          {(t.errorCodes && t.errorCodes[String(result.error)]) || String(result.error)}
          {result.requestId ? (
            <div className="req-id">
              {t.requestId}: <code>{String(result.requestId)}</code>
            </div>
          ) : null}
        </div>
      ) : result?.runId ? (
        <>
          {steps.length ? (
            <div className="result-box">
              <div className="text-block">
                <h4>{t.agentSteps}</h4>
                <ul className="file-list">
                  {steps.map((s, i) => (
                    <li key={i}>
                      <div className="file-head">
                        <b>{(t.agentStepNames && t.agentStepNames[s.name]) || s.name}</b>
                        <span className="row-actions">
                          <span className="status status-ready">{s.status}</span>
                          {s.detail ? <span className="tag">{s.detail}</span> : null}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {result.summary ? (
            <div className="result-box">
              <div className="text-block">
                <h4>{t.buildSummary}</h4>
                <Markdown>{String(result.summary)}</Markdown>
              </div>
            </div>
          ) : null}

          <div className="list-head">
            <h3>
              {t.agentResultFiles} ({files.length})
            </h3>
            <span className="row-actions">
              <VerificationBadge verification={result.verification} t={t} />
              {files.length ? (
                <button className="ghost sm" onClick={() => downloadZip("ghost-agent-build", files)}>
                  <Icon name="archive" /> {t.downloadZipBtn}
                </button>
              ) : null}
            </span>
          </div>
          {files.length ? (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={i}>
                  <div className="file-head">
                    <b>{String(f.path)}</b>
                  </div>
                  <div className="file-body md-scroll">
                    <Markdown>{String(f.content)}</Markdown>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="result-box empty">{t.agentNoRunYet}</div>
      )}
    </section>
  );
}
