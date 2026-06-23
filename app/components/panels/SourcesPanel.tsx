"use client";

import { useMemo, useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { Pagination, usePaged } from "../Pagination";

// Infer a coarse source type from its URL for the table's Type column / tabs.
function srcType(url: string): { key: "web" | "github"; label: string; icon: string } {
  return url.toLowerCase().includes("github.com")
    ? { key: "github", label: "GitHub", icon: "github" }
    : { key: "web", label: "Web", icon: "link" };
}

export function SourcesPanel({ g }: { g: GhostData }) {
  const { t, topics, sources, selectedTopic, setSelectedTopic, loading, output, query } = g;

  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicDesc, setNewTopicDesc] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [deepIngest, setDeepIngest] = useState(false);

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

  const { page, setPage, pageCount, visible } = usePaged(typed, 8);

  async function createTopic() {
    if (newTopicName.trim().length < 2) return;
    await g.createTopic(newTopicName, newTopicDesc);
    setNewTopicName("");
    setNewTopicDesc("");
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
  }

  return (
    <section className="panel">
      <div className="explain">{t.sourcesExplain}</div>

      <div className="form-card">
        <h3 className="card-title">{t.topicSection}</h3>
        <div className="form-row">
          <div>
            <label>{t.newTopicName}</label>
            <input value={newTopicName} onChange={(e) => setNewTopicName(e.target.value)} placeholder="Authentication" />
          </div>
          <div>
            <label>{t.newTopicDesc}</label>
            <input value={newTopicDesc} onChange={(e) => setNewTopicDesc(e.target.value)} placeholder="JWT, OAuth, sessions" />
          </div>
        </div>
        <button className="primary" onClick={createTopic} disabled={newTopicName.trim().length < 2}>
          <Icon name="plus" /> {t.createTopic}
        </button>
      </div>

      <div className="form-card">
        <label>{t.selectTopic}</label>
        <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)}>
          <option value="">{"\u2014"}</option>
          {topics.map((tp) => (
            <option key={String(tp.id)} value={String(tp.id)}>
              {String(tp.name)}
            </option>
          ))}
        </select>
        {!topics.length ? <p className="muted">{t.noTopics}</p> : null}
        {selectedTopic ? (
          <>
            <label>{t.urlLabel}</label>
            <textarea
              className="url-multi"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder={"https://docs.example.com/guide\nhttps://example.com/blog/article"}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addSource();
              }}
            />
            <p className="muted url-hint">{t.urlMultiHint}</p>
            <p className="muted url-hint">{t.githubSourceHint}</p>
            <label className="deep-toggle">
              <input
                type="checkbox"
                checked={deepIngest}
                onChange={(e) => setDeepIngest(e.target.checked)}
              />
              <span>{t.deepIngestLabel}</span>
            </label>
            <p className="muted url-hint">{t.deepIngestHint}</p>
            <label>{t.tagsLabel}</label>
            <input value={sourceTags} onChange={(e) => setSourceTags(e.target.value)} placeholder="docs, api" />
            <button className="primary" onClick={addSource} disabled={loading.sources || !parsedUrls.length}>
              <Icon name="plus" />{" "}
              {loading.sources ? t.learning : parsedUrls.length > 1 ? t.addSourcesMulti : t.addSource}
            </button>
          </>
        ) : (
          <p className="muted">{t.topicRequired}</p>
        )}
      </div>

      {selectedTopic ? (
        <>
          <div className="list-head">
            <h3>
              {t.learnedSources} ({filtered.length})
            </h3>
            <button className="ghost sm" onClick={() => g.loadSources(selectedTopic)}>
              <Icon name="refresh" /> {t.refreshList}
            </button>
          </div>
          {!sources.length ? (
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
        </>
      ) : null}
      <ResultView k="sources" output={output} loading={loading} t={t} />
    </section>
  );
}
