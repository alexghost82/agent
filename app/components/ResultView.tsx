"use client";

import { Json } from "../api";
import { Markdown } from "../markdown";
import { ResultSkeleton } from "./Skeleton";

/** Renders an action result: loading / empty / error (mapped code + requestId) / markdown blocks. */
export function ResultView({
  k,
  output,
  loading,
  t
}: {
  k: string;
  output: Record<string, Json | null>;
  loading: Record<string, boolean>;
  t: any;
}) {
  const data = output[k];
  const isLoading = loading[k];

  if (isLoading) return <ResultSkeleton label={t.working} />;
  if (!data) return <div className="result-box empty">{t.resultEmpty}</div>;

  if (data.error) {
    const code = String(data.error);
    const msg = (t.errorCodes && t.errorCodes[code]) || code;
    const requestId = data.requestId ? String(data.requestId) : "";
    return (
      <div className="result-box err">
        <strong>{t.errorWord}:</strong> {msg}
        {requestId ? (
          <div className="req-id">
            {t.requestId}: <code>{requestId}</code>
          </div>
        ) : null}
      </div>
    );
  }

  const fields = ["answer", "plan", "design", "result"];
  const blocks = fields.filter((f) => typeof data[f] === "string");
  return (
    <div className="result-box">
      {blocks.map((f) => (
        <div key={f} className="text-block">
          <h4>{t.resultLabels[f]}</h4>
          <Markdown>{String(data[f])}</Markdown>
        </div>
      ))}
      {!blocks.length && <pre>{JSON.stringify(data, null, 2)}</pre>}
      {blocks.length ? (
        <details className="raw">
          <summary>{t.showRaw}</summary>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
