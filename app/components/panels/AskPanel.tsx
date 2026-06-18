"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { ResultView } from "../ResultView";

export function AskPanel({ g }: { g: GhostData }) {
  const { t, loading, output } = g;
  const [question, setQuestion] = useState("");

  return (
    <section className="panel">
      <div className="explain">{t.askExplain}</div>
      <div className="form-card">
        <label>{t.questionLabel}</label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What did we learn about authentication?"
        />
        <button className="primary" onClick={() => g.ask(question)} disabled={loading.ask || question.trim().length < 3}>
          {loading.ask ? t.thinking : t.ask}
        </button>
      </div>
      <ResultView k="ask" output={output} loading={loading} t={t} />
    </section>
  );
}
