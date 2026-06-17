"use client";

import { useCallback, useEffect, useState } from "react";
import "./styles.css";
import { DICT, STEP_KEYS, STEP_META, type Lang, type Theme, type StepKey } from "./i18n";
import { Icon } from "./icons";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
type Json = Record<string, unknown>;

function authHeader(): Record<string, string> {
  try {
    const a = JSON.parse(localStorage.getItem("ghost.auth") || "null");
    return a?.token ? { Authorization: `Bearer ${a.token}` } : {};
  } catch {
    return {};
  }
}

async function request(path: string, method: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 401 && path !== "/login") {
    localStorage.removeItem("ghost.auth");
    if (typeof window !== "undefined") window.location.reload();
    throw new Error("unauthorized");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const getJson = (p: string) => request(p, "GET");
const postJson = (p: string, b: unknown) => request(p, "POST", b);
const patchJson = (p: string, b: unknown) => request(p, "PATCH", b);

function downloadMd(name: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".md") ? name : `${name}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const [theme, setTheme] = useState<Theme>("dark");
  const [auth, setAuth] = useState<{ username: string; token: string } | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [active, setActive] = useState<StepKey>("overview");
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [output, setOutput] = useState<Record<string, Json | null>>({});

  const [stats, setStats] = useState<Json | null>(null);
  const [topics, setTopics] = useState<Json[]>([]);
  const [sources, setSources] = useState<Json[]>([]);
  const [skills, setSkills] = useState<Json[]>([]);
  const [projects, setProjects] = useState<Json[]>([]);
  const [plans, setPlans] = useState<Json[]>([]);

  const [selectedTopic, setSelectedTopic] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicDesc, setNewTopicDesc] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [pName, setPName] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pStack, setPStack] = useState("");
  const [pRepo, setPRepo] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [tokenMsg, setTokenMsg] = useState("");
  const [question, setQuestion] = useState("");
  const [designSection, setDesignSection] = useState("");
  const [planInstructions, setPlanInstructions] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const t = DICT[lang];
  const rtl = lang === "he";

  useEffect(() => {
    const savedLang = (localStorage.getItem("ghost.lang") as Lang) || "en";
    const savedTheme = (localStorage.getItem("ghost.theme") as Theme) || "dark";
    setLang(savedLang);
    setTheme(savedTheme);
    const savedAuth = localStorage.getItem("ghost.auth");
    if (savedAuth) {
      try {
        setAuth(JSON.parse(savedAuth));
      } catch {
        /* */
      }
    }
    setAuthReady(true);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
    localStorage.setItem("ghost.lang", lang);
    localStorage.setItem("ghost.theme", theme);
  }, [lang, theme]);

  async function doLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setLoginErr("");
    setLoginLoading(true);
    try {
      const r = await postJson("/login", { username: loginUser.trim(), password: loginPass });
      const a = { username: r.user.username, token: r.token };
      localStorage.setItem("ghost.auth", JSON.stringify(a));
      setAuth(a);
      setLoginPass("");
    } catch (e: any) {
      setLoginErr(e.message || t.login.error);
    } finally {
      setLoginLoading(false);
    }
  }
  function logout() {
    localStorage.removeItem("ghost.auth");
    setAuth(null);
    setActive("overview");
  }

  const run = useCallback(async (key: string, action: () => Promise<Json>) => {
    setLoading((l) => ({ ...l, [key]: true }));
    setOutput((o) => ({ ...o, [key]: null }));
    try {
      const res = await action();
      setOutput((o) => ({ ...o, [key]: res }));
      return res;
    } catch (e: any) {
      setOutput((o) => ({ ...o, [key]: { error: e.message } }));
      return null;
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      setStats(await getJson("/dashboard"));
    } catch {
      /* */
    }
  }, []);
  const loadTopics = useCallback(async () => {
    try {
      setTopics((await getJson("/topics")).topics || []);
    } catch {
      /* */
    }
  }, []);
  const loadSources = useCallback(async (topicId: string) => {
    if (!topicId) {
      setSources([]);
      return;
    }
    try {
      setSources((await getJson(`/sources?topicId=${encodeURIComponent(topicId)}`)).sources || []);
    } catch {
      /* */
    }
  }, []);
  const loadSkills = useCallback(async () => {
    try {
      setSkills((await getJson("/skills")).skills || []);
    } catch {
      /* */
    }
  }, []);
  const loadProjects = useCallback(async () => {
    try {
      setProjects((await getJson("/projects")).projects || []);
    } catch {
      /* */
    }
  }, []);
  const loadPlans = useCallback(async (projectId: string) => {
    if (!projectId) {
      setPlans([]);
      return;
    }
    try {
      setPlans((await getJson(`/generated-plans?projectId=${encodeURIComponent(projectId)}`)).plans || []);
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    loadDashboard();
    loadTopics();
  }, [auth, loadDashboard, loadTopics]);

  useEffect(() => {
    if (!auth) return;
    if (active === "overview") loadDashboard();
    if (active === "sources") loadTopics();
    if (active === "skills") {
      loadTopics();
      loadSkills();
    }
    if (active === "projects") {
      loadProjects();
      loadSkills();
    }
    if (active === "design" || active === "plan") loadProjects();
  }, [active, auth, loadDashboard, loadTopics, loadSkills, loadProjects]);

  useEffect(() => {
    loadSources(selectedTopic);
  }, [selectedTopic, loadSources]);

  useEffect(() => {
    loadPlans(selectedProject);
    const p = projects.find((x) => String(x.id) === selectedProject);
    setSelectedSkillIds(Array.isArray(p?.skillIds) ? (p!.skillIds as string[]) : []);
  }, [selectedProject, projects, loadPlans]);

  async function createTopic() {
    if (newTopicName.trim().length < 2) return;
    const r = await postJson("/topics", { name: newTopicName.trim(), description: newTopicDesc.trim() || undefined });
    setNewTopicName("");
    setNewTopicDesc("");
    await loadTopics();
    if (r?.id) setSelectedTopic(String(r.id));
    loadDashboard();
  }
  async function addSource() {
    if (!selectedTopic || !sourceUrl.trim()) return;
    const tags = sourceTags.split(",").map((x) => x.trim()).filter(Boolean);
    await run("sources", () =>
      postJson("/learn", { topicId: selectedTopic, url: sourceUrl.trim(), tags: tags.length ? tags : undefined })
    );
    setSourceUrl("");
    setSourceTags("");
    loadSources(selectedTopic);
    loadDashboard();
  }
  async function extractSkills() {
    if (!selectedTopic) return;
    await run("skills", async () => {
      const r = await postJson("/extract-skills", { topicId: selectedTopic });
      loadSkills();
      loadDashboard();
      return r;
    });
  }
  async function createProject() {
    await run("projectCreate", async () => {
      const r = await postJson("/projects", {
        name: pName,
        description: pDesc,
        stack: pStack || undefined,
        repoUrl: pRepo || undefined
      });
      setPName("");
      setPDesc("");
      setPStack("");
      setPRepo("");
      loadProjects();
      loadDashboard();
      return r;
    });
  }
  async function saveGithubToken() {
    if (!ghToken.trim()) return;
    setTokenMsg("");
    try {
      await postJson("/github-token", { token: ghToken.trim() });
      setGhToken("");
      setTokenMsg(t.tokenSaved);
    } catch (e: any) {
      setTokenMsg(e.message);
    }
  }
  async function connectGithub(projectId: string, repoUrl: string) {
    await run(`gh-${projectId}`, async () => {
      const r = await postJson(`/projects/${projectId}/connect-github`, { repoUrl });
      loadProjects();
      loadDashboard();
      return r;
    });
  }
  function toggleSkill(id: string) {
    setSelectedSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  async function saveProjectSkills() {
    if (!selectedProject) return;
    await run("saveSkills", async () => {
      const r = await patchJson(`/projects/${selectedProject}`, { skillIds: selectedSkillIds });
      loadProjects();
      return { ...r, saved: true };
    });
  }
  async function generatePlan() {
    if (!selectedProject) return;
    await run("plan", async () => {
      const r = await postJson("/generate-plan", {
        projectId: selectedProject,
        instructions: planInstructions.trim() || undefined
      });
      loadPlans(selectedProject);
      loadDashboard();
      return r;
    });
  }

  function ResultView({ k }: { k: string }) {
    const data = output[k];
    const isLoading = loading[k];
    if (isLoading)
      return (
        <div className="result-box loading">
          <span className="spinner" /> {t.working}
        </div>
      );
    if (!data) return <div className="result-box empty">{t.resultEmpty}</div>;
    if (data.error)
      return (
        <div className="result-box err">
          <strong>{t.errorWord}:</strong> {String(data.error)}
        </div>
      );
    const fields = ["answer", "plan", "design", "result"];
    const blocks = fields.filter((f) => typeof data[f] === "string");
    return (
      <div className="result-box">
        {blocks.map((f) => (
          <div key={f} className="text-block">
            <h4>{t.resultLabels[f]}</h4>
            <p>{String(data[f])}</p>
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

  const counts = (stats?.counts as Record<string, number>) || {};
  const meta = STEP_META[active];

  if (!authReady) return null;

  if (!auth) {
    return (
      <div className={`login-wrap ${rtl ? "rtl" : ""}`}>
        <div className="login-top">
          <div className="seg">
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
              EN
            </button>
            <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>
              HEB
            </button>
          </div>
          <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="theme">
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
        <form className="login-card" onSubmit={doLogin}>
          <img src="/ghost-logo.png" alt="GHOST" className="login-logo" />
          <h1>GHOST Agent Builder</h1>
          <p className="login-sub">{t.login.title}</p>
          <label>{t.login.username}</label>
          <input value={loginUser} onChange={(e) => setLoginUser(e.target.value)} placeholder="Alex" autoFocus autoComplete="username" />
          <label>{t.login.password}</label>
          <input
            type="password"
            value={loginPass}
            onChange={(e) => setLoginPass(e.target.value)}
            placeholder="••••••"
            autoComplete="current-password"
          />
          {loginErr ? <div className="login-err">{loginErr}</div> : null}
          <button className="primary" type="submit" disabled={loginLoading || !loginUser.trim() || !loginPass}>
            {loginLoading ? t.login.signingIn : t.login.signIn}
          </button>
        </form>
      </div>
    );
  }

  const planOutput = output.plan as any;

  return (
    <div className={`app ${rtl ? "rtl" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src="/ghost-logo.png" alt="GHOST" className="brand-logo" />
          <div>
            <strong>GHOST Agent Builder</strong>
            <span className="brand-sub">{t.brandSub}</span>
          </div>
        </div>

        <div className="switchers">
          <div className="seg">
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
              EN
            </button>
            <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>
              HEB
            </button>
          </div>
          <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="theme">
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>

        <p className="nav-label">{t.workflow}</p>
        <nav className="nav">
          {STEP_KEYS.map((key) => (
            <button key={key} className={`nav-item ${active === key ? "is-active" : ""}`} onClick={() => setActive(key)}>
              <span className="nav-num">{STEP_META[key].n}</span>
              <span className="nav-ic">
                <Icon name={STEP_META[key].icon} />
              </span>
              <span className="nav-text">{t.steps[key].title}</span>
            </button>
          ))}
        </nav>

        <div className="mini-stats">
          <div>
            <b>{counts.sources ?? "—"}</b>
            <span>{t.miniSources}</span>
          </div>
          <div>
            <b>{counts.agent_skills ?? "—"}</b>
            <span>{t.miniSkills}</span>
          </div>
          <div>
            <b>{counts.projects ?? "—"}</b>
            <span>{t.miniProjects}</span>
          </div>
        </div>

        <div className="user-row">
          <span className="user-ava">{auth.username.charAt(0).toUpperCase()}</span>
          <span className="user-name">{auth.username}</span>
          <button className="logout" onClick={logout} title={t.login.logout} aria-label={t.login.logout}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="page-head">
          <div>
            <p className="crumb">
              {t.step} {meta.n === "•" ? "—" : meta.n}
            </p>
            <h1>{t.steps[active].title}</h1>
            <p className="page-hint">{t.steps[active].hint}</p>
          </div>
          <button
            className="ghost"
            onClick={() => {
              loadDashboard();
              loadTopics();
              loadSkills();
              loadProjects();
            }}
          >
            <Icon name="refresh" /> {t.refresh}
          </button>
        </header>

        {active === "overview" && (
          <section className="panel">
            <div className="stat-grid">
              {Object.keys(t.statLabels).map((k) => (
                <div key={k} className="stat-card">
                  <b>{counts[k] ?? "—"}</b>
                  <span>{t.statLabels[k]}</span>
                </div>
              ))}
            </div>
            <div className="text-block" style={{ marginTop: 18 }}>
              <h4>{t.recentTitle}</h4>
              {Array.isArray(stats?.recentLogs) && (stats!.recentLogs as Json[]).length ? (
                <ul className="log-list">
                  {(stats!.recentLogs as Json[]).map((l) => (
                    <li key={String(l.id)}>
                      <span className="tag">{String(l.type)}</span> {String(l.message)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t.noEvents}</p>
              )}
            </div>
          </section>
        )}

        {active === "sources" && (
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
                <option value="">—</option>
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
                  <input
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo or https://docs..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addSource();
                    }}
                  />
                  <label>{t.tagsLabel}</label>
                  <input value={sourceTags} onChange={(e) => setSourceTags(e.target.value)} placeholder="docs, api" />
                  <button className="primary" onClick={addSource} disabled={loading.sources || !sourceUrl.trim()}>
                    <Icon name="plus" /> {loading.sources ? t.learning : t.addSource}
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
                  <button className="ghost sm" onClick={() => loadSources(selectedTopic)}>
                    <Icon name="refresh" /> {t.refreshList}
                  </button>
                </div>
                {sources.length ? (
                  <ul className="source-list">
                    {sources.map((s) => (
                      <li key={String(s.id)}>
                        <span className="src-ic">
                          <Icon name="link" />
                        </span>
                        <div className="src-main">
                          <a href={String(s.url)} target="_blank" rel="noreferrer">
                            {String(s.title || s.url)}
                          </a>
                          <span className="src-url">{String(s.url)}</span>
                        </div>
                        <span className="src-chunks">
                          {Number(s.chunkCount ?? s.chunks ?? 0)} {t.chunksUnit}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t.noSources}</p>
                )}
              </>
            ) : null}
            <ResultView k="sources" />
          </section>
        )}

        {active === "skills" && (
          <section className="panel">
            <div className="explain">{t.skillsExplain}</div>
            <div className="form-card">
              <label>{t.selectTopic}</label>
              <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)}>
                <option value="">—</option>
                {topics.map((tp) => (
                  <option key={String(tp.id)} value={String(tp.id)}>
                    {String(tp.name)}
                  </option>
                ))}
              </select>
              <button className="primary" onClick={extractSkills} disabled={loading.skills || !selectedTopic}>
                <Icon name="skills" /> {loading.skills ? t.extracting : t.createSkillFromTopic}
              </button>
            </div>
            <div className="list-head">
              <h3>
                {t.mySkills} ({skills.length})
              </h3>
              <button className="ghost sm" onClick={loadSkills}>
                <Icon name="refresh" /> {t.refreshList}
              </button>
            </div>
            {skills.length ? (
              <ul className="skill-list">
                {skills.map((s) => (
                  <li key={String(s.id)}>
                    <div className="skill-head">
                      <b>{String(s.skillName)}</b>
                      {s.source === "learned" ? <span className="tag">{t.learnedTag}</span> : null}
                    </div>
                    <p>{String(s.description)}</p>
                    {s.example ? (
                      <code className="skill-ex">
                        {t.exampleLabel}: {String(s.example)}
                      </code>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.noSkills}</p>
            )}
            <ResultView k="skills" />
          </section>
        )}

        {active === "projects" && (
          <section className="panel">
            <div className="explain">{t.projectExplain}</div>

            <div className="form-card">
              <div className="form-row">
                <div>
                  <label>{t.nameLabel}</label>
                  <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="My SaaS" />
                </div>
                <div>
                  <label>{t.stackLabel}</label>
                  <input value={pStack} onChange={(e) => setPStack(e.target.value)} placeholder="Next.js, Firebase" />
                </div>
              </div>
              <label>{t.descLabel}</label>
              <textarea value={pDesc} onChange={(e) => setPDesc(e.target.value)} placeholder="What the project does" />
              <label>{t.repoLabel}</label>
              <input value={pRepo} onChange={(e) => setPRepo(e.target.value)} placeholder="https://github.com/you/repo" />
              <button
                className="primary"
                onClick={createProject}
                disabled={loading.projectCreate || pName.trim().length < 2 || pDesc.trim().length < 5}
              >
                <Icon name="plus" /> {t.createProject}
              </button>
            </div>

            <div className="form-card">
              <h3 className="card-title">{t.githubSection}</h3>
              <label>{t.githubTokenLabel}</label>
              <input
                type="password"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                placeholder="ghp_…"
                autoComplete="off"
              />
              <button className="ghost sm" onClick={saveGithubToken} disabled={!ghToken.trim()}>
                <Icon name="github" /> {t.saveToken}
              </button>
              {tokenMsg ? <span className="badge-line">{tokenMsg}</span> : null}
            </div>

            {projects.length ? (
              <>
                <div className="list-head">
                  <h3>{t.steps.projects.title} ({projects.length})</h3>
                </div>
                <ul className="task-list">
                  {projects.map((p) => {
                    const status = String(p.ingestStatus || "none");
                    const repoUrl = String(p.repoUrl || "");
                    return (
                      <li key={String(p.id)} className="proj-item">
                        <div className="task-main">
                          <b>{String(p.name)}</b>
                          <span>
                            {repoUrl || "—"} · {Number(p.ingestedFiles ?? 0)} {t.filesIndexed}
                          </span>
                          {p.summary ? <p className="appr-review">{String(p.summary).slice(0, 320)}…</p> : null}
                        </div>
                        <span className={`status status-${status}`}>{t[`ingest_${status}`] || status}</span>
                        <button
                          className="ghost sm"
                          onClick={() => connectGithub(String(p.id), repoUrl)}
                          disabled={!repoUrl || !!loading[`gh-${p.id}`]}
                        >
                          <Icon name="github" /> {loading[`gh-${p.id}`] ? t.connecting : t.connectGithub}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="muted">{t.noProjects}</p>
            )}

            <div className="form-card">
              <label>{t.selectProject}</label>
              <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
              </select>
              {selectedProject ? (
                <>
                  <label>{t.skillsToUse}</label>
                  {skills.length ? (
                    <div className="skill-pick">
                      {skills.map((s) => (
                        <label key={String(s.id)} className="check">
                          <input
                            type="checkbox"
                            checked={selectedSkillIds.includes(String(s.id))}
                            onChange={() => toggleSkill(String(s.id))}
                          />
                          <span>{String(s.skillName)}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">{t.noSkillsYet}</p>
                  )}
                  <button className="primary" onClick={saveProjectSkills} disabled={loading.saveSkills}>
                    {t.saveSkills}
                  </button>
                  {(output.saveSkills as any)?.saved ? <span className="badge-line">{t.skillsSaved}</span> : null}
                </>
              ) : null}
            </div>
            <ResultView k="projectCreate" />
          </section>
        )}

        {active === "ask" && (
          <section className="panel">
            <div className="explain">{t.askExplain}</div>
            <div className="form-card">
              <label>{t.questionLabel}</label>
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What did we learn about authentication?" />
              <button
                className="primary"
                onClick={() => run("ask", () => postJson("/ask", { question }))}
                disabled={loading.ask || question.trim().length < 3}
              >
                {loading.ask ? t.thinking : t.ask}
              </button>
            </div>
            <ResultView k="ask" />
          </section>
        )}

        {active === "design" && (
          <section className="panel">
            <div className="explain">{t.designExplain}</div>
            <div className="form-card">
              <label>{t.selectProject}</label>
              <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
              </select>
              <label>{t.sectionLabel}</label>
              <input value={designSection} onChange={(e) => setDesignSection(e.target.value)} placeholder="billing, onboarding, admin…" />
              <button
                className="primary"
                onClick={() => run("design", () => postJson("/design", { projectId: selectedProject, section: designSection.trim() || undefined }))}
                disabled={loading.design || !selectedProject}
              >
                <Icon name="plan" /> {loading.design ? t.designing : t.designBtn}
              </button>
            </div>
            <ResultView k="design" />
          </section>
        )}

        {active === "plan" && (
          <section className="panel">
            <div className="explain">{t.planExplain}</div>
            <div className="form-card">
              <label>{t.selectProject}</label>
              <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
              </select>
              <label>{t.instructionsLabel}</label>
              <textarea value={planInstructions} onChange={(e) => setPlanInstructions(e.target.value)} placeholder="Focus on the migration plan…" />
              <button className="primary" onClick={generatePlan} disabled={loading.plan || !selectedProject}>
                <Icon name="generate" /> {loading.plan ? t.generating : t.generate}
              </button>
            </div>

            {loading.plan ? (
              <div className="result-box loading">
                <span className="spinner" /> {t.working}
              </div>
            ) : planOutput?.error ? (
              <div className="result-box err">
                <strong>{t.errorWord}:</strong> {String(planOutput.error)}
              </div>
            ) : planOutput && (Array.isArray(planOutput.files) || Array.isArray(planOutput.prompts)) ? (
              <>
                {Array.isArray(planOutput.files) && planOutput.files.length ? (
                  <>
                    <div className="list-head">
                      <h3>{t.generatedFiles} ({planOutput.files.length})</h3>
                    </div>
                    <ul className="file-list">
                      {planOutput.files.map((f: any, i: number) => (
                        <li key={i}>
                          <div className="file-head">
                            <b>{String(f.path)}</b>
                            <button className="ghost sm" onClick={() => downloadMd(String(f.path), String(f.content))}>
                              <Icon name="download" /> {t.download}
                            </button>
                          </div>
                          <pre className="file-body">{String(f.content)}</pre>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {Array.isArray(planOutput.prompts) && planOutput.prompts.length ? (
                  <>
                    <div className="list-head">
                      <h3>{t.promptsTitle} ({planOutput.prompts.length})</h3>
                    </div>
                    <ul className="file-list">
                      {planOutput.prompts.map((p: any, i: number) => (
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
        )}
      </main>
    </div>
  );
}
