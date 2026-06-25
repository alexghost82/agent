"use client";

import { useMemo, useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { Pagination, usePaged } from "../Pagination";
import { Modal } from "../Modal";

// Infer a coarse source type from its URL for the table's Type column / tabs.
function srcType(url: string): { key: "web" | "github"; label: string; icon: string } {
  return url.toLowerCase().includes("github.com")
    ? { key: "github", label: "GitHub", icon: "github" }
    : { key: "web", label: "Web", icon: "link" };
}

export function SourcesPanel({ g }: { g: GhostData }) {
  const { t, topics, sources, selectedTopic, setSelectedTopic, loading, output, query, ingestProgress } = g;

  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicDesc, setNewTopicDesc] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [deepIngest, setDeepIngest] = useState(false);
  const [showTopic, setShowTopic] = useState(false);
  const [showSource, setShowSource] = useState(false);

  // Filter the learned sources by the global top-bar search (title or URL).
  const q = (query || "").trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? sources.filter((s) =>
            `${String(s.title || "")} ${String(s.url || "")}`.toLowerCase().includes(q)
          )
        : sources,
    [sources, q]
  );

  const [tab, setTab] = useState<"all" | "web" | "github">("all");
  const typed = useMemo(
    () => (tab === "all" ? filtered : filtered.filter((s) => srcType(String(s.url || "")).key === tab)),
    [filtered, tab]
  );
  const webCount = useMemo(() => filtered.filter((s) => srcType(String(s.url || "")).key === "web").length, [filtered]);
  const ghCount = useMemo(() => filtered.filter((s) => srcType(String(s.url || "")).key === "github").length, [filtered]);

  // Totals across all sources (for the right-rail overview, not search-scoped).
  const allWeb = useMemo(() => sources.filter((s) => srcType(String(s.url || "")).key === "web").length, [sources]);
  const allGh = useMemo(() => sources.filter((s) => srcType(String(s.url || "")).key === "github").length, [sources]);
  const totalChunks = useMemo(
    () => sources.reduce((sum, s) => sum + Number(s.chunkCount ?? s.chunks ?? 0), 0),
    [sources]
  );
  const pct = (n: number) => (sources.length ? `${Math.round((n / sources.length) * 100)}%` : "0%");

  const { page, setPage, pageCount, visible } = usePaged(typed, 8);

  async function createTopic() {
    if (newTopicName.trim().length < 2) return;
    await g.createTopic(newTopicName, newTopicDesc);
    setNewTopicName("");
    setNewTopicDesc("");
    setShowTopic(false);
  }

  // Accept several resource URLs at once: one per line, or separated by commas
  // / whitespace. A single URL keeps using the original single-source path.
  const parsedUrls = sourceUrl
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  async function addSource() {
    if (!selectedTopic || !parsedUrls.length) return;
    const tags = sourceTags.split(",").map((x) => x.trim()).filter(Boolean);
    if (parsedUrls.length === 1) {
      await g.addSource(selectedTopic, parsedUrls[0], tags, deepIngest);
    } else {
      await g.addSources(selectedTopic, parsedUrls, tags, deepIngest);
    }
    setSourceUrl("");
    setSourceTags("");
    setShowSource(false);
  }

  return (
    <section className="panel">
      <div className="page-toolbar">
        <div className="pt-left">
          <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)} aria-label={t.selectTopic}>
            <option value="">{t.selectTopic}</option>
            {topics.map((tp) => (
              <option key={String(tp.id)} value={String(tp.id)}>
                {String(tp.name)}
              </option>
            ))}
          </select>
        </div>
        <div className="pt-actions">
          <button className="ghost" onClick={() => setShowTopic(true)}>
            <Icon name="plus" /> {t.createTopic}
          </button>
          <button className="primary" onClick={() => setShowSource(true)} disabled={!selectedTopic}>
            <Icon name="plus" /> {t.addSource}
          </button>
        </div>
      </div>

      <div className="page-grid">
        <div className="pg-main">
          {ingestProgress ? (() => {
            const ip = ingestProgress;
            const pct = ip.total ? Math.round((ip.done / ip.total) * 100) : 0;
            const remaining = ip.total - ip.done;
            const running = !!loading.sources;
            return (
              <div className="ingest-progress" role="status" aria-live="polite">
                <div className="ip-head">
                  <span className={`ip-title ${running ? "running" : "done"}`}>
                    <Icon name={running ? "refresh" : "check"} />
                    {running ? t.trainingProgress : t.trainingDone}
                  </span>
                  <span className="ip-pct">{pct}%</span>
                  {!running && (
                    <button className="ip-close" onClick={g.clearIngestProgress} aria-label="Dismiss" title="Dismiss">
                      ×
                    </button>
                  )}
                </div>
                <div className="ip-track">
                  <span className="ip-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="ip-meta">
                  <span>{t.trainingLearned.replace("{a}", String(ip.saved)).replace("{b}", String(ip.total))}</span>
                  {remaining > 0 ? (
                    <span className="muted">{t.trainingRemaining.replace("{n}", String(remaining))}</span>
                  ) : null}
                  {ip.failed > 0 ? (
                    <span className="ip-fail-text">
                      {ip.failed} {t.trainingFailed}
                    </span>
                  ) : null}
                </div>
                {ip.current ? (
                  <div className="ip-current">
                    <span className="ip-spin" />
                    <span className="ip-current-lbl">{t.trainingCurrent}:</span>
                    <span className="ip-url">{ip.current}</span>
                  </div>
                ) : null}
                <ul className="ip-list">
                  {ip.items.map((it, i) => (
                    <li key={`${it.url}-${i}`} className={`ip-item ip-${it.status}`}>
                      <span className="ip-ic">
                        {it.status === "done" ? (
                          <Icon name="check" />
                        ) : it.status === "learning" ? (
                          <Icon name="refresh" />
                        ) : it.status === "failed" ? (
                          <span className="ip-x">×</span>
                        ) : (
                          <span className="ip-dot" />
                        )}
                      </span>
                      <span className="ip-item-url">{it.url}</span>
                      {it.status === "done" && it.chunks != null ? (
                        <span className="ip-chunks">
                          {it.chunks} {t.chunksUnit}
                        </span>
                      ) : it.status === "learning" ? (
                        <span className="ip-state">{t.learning}</span>
                      ) : it.status === "pending" ? (
                        <span className="ip-state muted">{t.trainingPending}</span>
                      ) : it.status === "failed" ? (
                        <span className="ip-state ip-fail-text" title={it.error || ""}>
                          {(it.error && (t.errorCodes as Record<string, string>)?.[it.error]) ||
                            it.error ||
                            t.trainingFailed}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })() : null}

          {!topics.length ? (
            <p className="muted">{t.noTopics}</p>
          ) : !selectedTopic ? (
            <p className="muted">{t.topicRequired}</p>
          ) : !sources.length ? (
            <p className="muted">{t.noSources}</p>
          ) : !filtered.length ? (
            <p className="muted">{t.searchEmpty}</p>
          ) : (
            <>
              <div className="list-tabs">
                <button className={`list-tab ${tab === "all" ? "on" : ""}`} onClick={() => setTab("all")}>
                  {t.allTab} <span className="cnt">{filtered.length}</span>
                </button>
                <button className={`list-tab ${tab === "web" ? "on" : ""}`} onClick={() => setTab("web")}>
                  Web <span className="cnt">{webCount}</span>
                </button>
                <button className={`list-tab ${tab === "github" ? "on" : ""}`} onClick={() => setTab("github")}>
                  GitHub <span className="cnt">{ghCount}</span>
                </button>
              </div>

              <div className="data-card">
                <div className="dt-head src-grid2">
                  <span>{t.learnedSources}</span>
                  <span>{t.colType}</span>
                  <span>{t.colStatus}</span>
                  <span className="dt-r">{t.chunksUnit}</span>
                  <span className="dt-r" />
                </div>
                {visible.map((s) => {
                  const id = String(s.id);
                  const reKey = `reingest-${id}`;
                  const delKey = `del-source-${id}`;
                  const url = String(s.url || "");
                  const ty = srcType(url);
                  const chunks = Number(s.chunkCount ?? s.chunks ?? 0);
                  const isDeep = !!s.deep;
                  return (
                    <div className="dt-row src-grid2" key={id}>
                      <div className="dt-cell-main">
                        <span className="dt-ic">
                          <Icon name={ty.icon} />
                        </span>
                        <span className="dt-tt">
                          <span className="dt-name">
                            <a href={url} target="_blank" rel="noreferrer">
                              {String(s.title || url)}
                            </a>
                          </span>
                          <span className="dt-sub">{url}</span>
                        </span>
                      </div>
                      <span className="dt-type">
                        <Icon name={ty.icon} /> {ty.label}
                      </span>
                      <span className="pill pill-ok">
                        <span className="pill-dot" />
                        {t.statusSynced}
                        {isDeep ? <span className="src-badge deep">{t.deepBadge}</span> : null}
                      </span>
                      <span className="dt-muted dt-r">{chunks}</span>
                      <div className="dt-actions">
                        <button
                          className="ghost sm"
                          onClick={() => g.reingestSource(s)}
                          disabled={!!loading[reKey]}
                          title={t.reingest}
                          aria-label={t.reingest}
                        >
                          <Icon name="refresh" />
                        </button>
                        <button
                          className="ghost sm danger-btn"
                          onClick={() => {
                            if (confirm(t.confirmDelete)) g.deleteSource(id);
                          }}
                          disabled={!!loading[delKey]}
                          title={t.delete}
                          aria-label={t.delete}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="list-foot">
                <span className="muted">
                  {t.showingOf.replace("{a}", String(visible.length)).replace("{b}", String(typed.length))}
                </span>
                <Pagination page={page} pageCount={pageCount} setPage={setPage} t={t} />
              </div>
            </>
          )}

          <ResultView k="sources" output={output} loading={loading} t={t} />
        </div>

        <aside className="pg-rail">
          <div className="card">
            <div className="card-head">
              <h3>{t.overviewTitle}</h3>
              <Icon name="overview" />
            </div>
            <div className="ov-grid">
              <div className="ov-cell">
                <span className="ov-num">{sources.length}</span>
                <span className="ov-lbl">{t.learnedSources}</span>
              </div>
              <div className="ov-cell">
                <span className="ov-num">{topics.length}</span>
                <span className="ov-lbl">{t.topicSection}</span>
              </div>
              <div className="ov-cell">
                <span className="ov-num">{allWeb}</span>
                <span className="ov-lbl">Web</span>
              </div>
              <div className="ov-cell">
                <span className="ov-num">{totalChunks.toLocaleString()}</span>
                <span className="ov-lbl">{t.chunksUnit}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>{t.colType}</h3>
            </div>
            <div className="ov-bars">
              <div className="ov-bar-row">
                <span className="ov-bar-name">
                  <span className="ov-dot" style={{ background: "var(--accent)" }} /> Web
                </span>
                <span className="ov-bar-val">{allWeb}</span>
                <span className="ov-bar-track">
                  <span className="ov-bar-fill" style={{ width: pct(allWeb) }} />
                </span>
              </div>
              <div className="ov-bar-row">
                <span className="ov-bar-name">
                  <span className="ov-dot" style={{ background: "var(--accent-2)" }} /> GitHub
                </span>
                <span className="ov-bar-val">{allGh}</span>
                <span className="ov-bar-track">
                  <span className="ov-bar-fill" style={{ width: pct(allGh) }} />
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <Modal open={showTopic} onClose={() => setShowTopic(false)} title={t.createTopic} subtitle={t.topicSection}>
        <label>{t.newTopicName}</label>
        <input value={newTopicName} onChange={(e) => setNewTopicName(e.target.value)} placeholder="Authentication" autoFocus />
        <label>{t.newTopicDesc}</label>
        <input value={newTopicDesc} onChange={(e) => setNewTopicDesc(e.target.value)} placeholder="JWT, OAuth, sessions" />
        <button className="primary" onClick={createTopic} disabled={newTopicName.trim().length < 2} style={{ marginTop: 14 }}>
          <Icon name="plus" /> {t.createTopic}
        </button>
      </Modal>

      <Modal open={showSource} onClose={() => setShowSource(false)} title={t.addSource} subtitle={t.urlMultiHint}>
        <label>{t.urlLabel}</label>
        <textarea
          className="url-multi"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder={"https://docs.example.com/guide\nhttps://example.com/blog/article"}
          rows={3}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addSource();
          }}
        />
        <p className="muted url-hint">{t.githubSourceHint}</p>
        <label className="deep-toggle">
          <input type="checkbox" checked={deepIngest} onChange={(e) => setDeepIngest(e.target.checked)} />
          <span>{t.deepIngestLabel}</span>
        </label>
        <p className="muted url-hint">{t.deepIngestHint}</p>
        <label>{t.tagsLabel}</label>
        <input value={sourceTags} onChange={(e) => setSourceTags(e.target.value)} placeholder="docs, api" />
        <button className="primary" onClick={addSource} disabled={loading.sources || !parsedUrls.length} style={{ marginTop: 14 }}>
          <Icon name="plus" /> {loading.sources ? t.learning : parsedUrls.length > 1 ? t.addSourcesMulti : t.addSource}
        </button>
      </Modal>
    </section>
  );
}
