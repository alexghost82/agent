"use client";

import { Json } from "../api";

type Step = { name: string; status: string; detail?: string };

// Phases the autopilot moves through, in order. The backend writes the current
// phase into the run's `status` field and pushes a completed `steps` entry per
// phase, so this stepper reflects real, live progress (not a fake timer).
const PHASES = ["learning", "skilling", "designing", "planning", "building"] as const;
const ORDER: Record<string, number> = {
  learning: 0,
  skilling: 1,
  designing: 2,
  planning: 3,
  building: 4,
  ready: 5,
  error: -1
};

export function ProcessTracker({ run, t }: { run: Json | null; t: any }) {
  const status = String((run?.status as string) || "learning");
  const steps: Step[] = Array.isArray(run?.steps) ? (run!.steps as Step[]) : [];
  const names = (t.agentStepNames as Record<string, string>) || {};
  const detailFor = (name: string) => steps.find((s) => s.name === name)?.detail;

  const isError = status === "error";
  const isReady = status === "ready";
  const doneCount = isError
    ? steps.filter((s) => s.status === "done").length
    : Math.min(ORDER[status] ?? 0, PHASES.length);
  const pct = Math.round((doneCount / PHASES.length) * 100);

  return (
    <div className="result-box tracker" aria-live="polite" aria-busy={!isReady && !isError}>
      <div className="tracker-head">
        <span className="tracker-title">
          <span className={`spinner ${isReady || isError ? "is-hidden" : ""}`} />
          {t.processTitle}
        </span>
        <span className="tracker-pct">{pct}%</span>
      </div>
      <div className="tracker-track">
        <div className={`tracker-fill ${isError ? "is-error" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <ol className="tracker-steps">
        {PHASES.map((name, i) => {
          let state: "done" | "active" | "pending" | "failed" = "pending";
          if (isError) {
            if (i < doneCount) state = "done";
            else if (i === doneCount) state = "failed";
          } else if (i < doneCount) {
            state = "done";
          } else if (i === doneCount && !isReady) {
            state = "active";
          } else if (isReady) {
            state = "done";
          }
          const detail = detailFor(name);
          return (
            <li key={name} className={`tracker-step is-${state}`}>
              <span className="tracker-dot">
                {state === "done" ? (
                  "\u2713"
                ) : state === "failed" ? (
                  "\u0021"
                ) : state === "active" ? (
                  <span className="spinner" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="tracker-label">{names[name] || name}</span>
              {detail ? <span className="tag">{detail}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
