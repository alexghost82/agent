"use client";

import { useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { Pagination, usePaged } from "../Pagination";

export function SourcesPanel({ g }: { g: GhostData }) {
  const { t, topics, sources, selectedTopic, setSelectedTopic, loading, output } = g;

  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicDesc, setNewTopicDesc] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [deepIngest, setDeepIngest] = useState(false);

  const { page, setPage, pageCount, visible } = usePaged(sources, 8);

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
              {t.learnedSources} ({sources.length})
            </h3>
            <button className="ghost sm" onClick={() => g.loadSources(selectedTopic)}>
              <Icon name="refresh" /> {t.refreshList}
            </button>
          </div>
          {sources.length ? (
            <>
              <ul className="source-list">
                {visible.map((s) => {
                  const id = String(s.id);
                  const reKey = `reingest-${id}`;
                  const delKey = `del-source-${id}`;
                  const pages = Number(s.pages ?? s.pageCount ?? 0);
                  const isDeep = !!s.deep;
                  const isSummarized = !!s.summarized;
                  const showLimited = pages > 1 || isDeep;
                  return (
                    <li key={id}>
                      <span className="src-ic">
                        <Icon name="link" />
                      </span>
                      <div className="src-main">
                        <a href={String(s.url)} target="_blank" rel="noreferrer">
                          {String(s.title || s.url)}
                        </a>
                        <span className="src-url">{String(s.url)}</span>
                      </div>
                      <span className="src-meta">
                        <span className="src-chunks">
                          {Number(s.chunkCount ?? s.chunks ?? 0)} {t.chunksUnit}
                        </span>
                        {pages > 0 ? (
                          <span className="src-pages">
                            {pages} {t.pagesUnit}
                          </span>
                        ) : null}
                        {isDeep ? <span className="src-badge deep">{t.deepBadge}</span> : null}
                        {isSummarized ? (
                          <span className="src-badge">{t.summarizedBadge}</span>
                        ) : null}
                        {showLimited ? (
                          <span className="src-limited">{t.limitedHint}</span>
                        ) : null}
                      </span>
                      <div className="row-actions">
                        <button
                          className="ghost sm"
                          onClick={() => g.reingestSource(s)}
                          disabled={!!loading[reKey]}
                          title={t.reingest}
                        >
                          <Icon name="refresh" /> {loading[reKey] ? t.reingesting : t.reingest}
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
                    </li>
                  );
                })}
              </ul>
              <Pagination page={page} pageCount={pageCount} setPage={setPage} t={t} />
            </>
          ) : (
            <p className="muted">{t.noSources}</p>
          )}
        </>
      ) : null}
      <ResultView k="sources" output={output} loading={loading} t={t} />
    </section>
  );
}
