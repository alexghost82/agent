"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Json,
  errorPayload,
  getJson,
  postJson,
  patchJson,
  delJson,
  serverLogout
} from "./api";
import { DICT, type Lang, type Theme, type StepKey } from "./i18n";

export type Auth = { username: string; token: string };

export function useGhostData() {
  const [lang, setLang] = useState<Lang>("en");
  const [theme, setTheme] = useState<Theme>("dark");
  const [auth, setAuth] = useState<Auth | null>(null);
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

  const t = DICT[lang];
  const rtl = lang === "he";

  /* ---------------- bootstrap / persisted prefs ---------------- */
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
        /* ignore corrupt value */
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

  /* ---------------- auth ---------------- */
  const doLogin = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setLoginErr("");
      setLoginLoading(true);
      try {
        const r = await postJson("/login", { username: loginUser.trim(), password: loginPass });
        const a = { username: r.user.username, token: r.token };
        localStorage.setItem("ghost.auth", JSON.stringify(a));
        setAuth(a);
        setLoginPass("");
      } catch (e: unknown) {
        const codes = (t.errorCodes as Record<string, string>) || {};
        const code = errorPayload(e).error;
        setLoginErr(codes[code] || (code === "internal" ? t.login.error : code) || t.login.error);
      } finally {
        setLoginLoading(false);
      }
    },
    [loginUser, loginPass, t]
  );

  // Contract §1: server-side logout clears the session, then we drop local state.
  const logout = useCallback(async () => {
    await serverLogout();
    localStorage.removeItem("ghost.auth");
    setAuth(null);
    setActive("overview");
    setStats(null);
    setTopics([]);
    setSources([]);
    setSkills([]);
    setProjects([]);
    setPlans([]);
    setSelectedTopic("");
    setSelectedProject("");
    setSelectedSkillIds([]);
  }, []);

  /* ---------------- run wrapper ---------------- */
  const run = useCallback(async (key: string, action: () => Promise<Json>) => {
    setLoading((l) => ({ ...l, [key]: true }));
    setOutput((o) => ({ ...o, [key]: null }));
    try {
      const res = await action();
      setOutput((o) => ({ ...o, [key]: res }));
      return res;
    } catch (e: unknown) {
      setOutput((o) => ({ ...o, [key]: errorPayload(e) }));
      return null;
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }, []);

  /* ---------------- loaders ---------------- */
  const loadDashboard = useCallback(async () => {
    try {
      setStats(await getJson("/dashboard"));
    } catch {
      /* dashboard is best-effort */
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

  const refreshAll = useCallback(() => {
    loadDashboard();
    loadTopics();
    loadSkills();
    loadProjects();
  }, [loadDashboard, loadTopics, loadSkills, loadProjects]);

  /* ---------------- effects: load per tab ---------------- */
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

  /* ---------------- ingest progress polling ---------------- */
  const ingesting = useMemo(
    () => projects.some((p) => String(p.ingestStatus || "") === "ingesting"),
    [projects]
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!auth || !ingesting) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => {
      loadProjects();
      loadDashboard();
    }, 2500);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [auth, ingesting, loadProjects, loadDashboard]);

  /* ---------------- topic / source actions ---------------- */
  const createTopic = useCallback(
    async (name: string, description: string) => {
      const r = await postJson("/topics", {
        name: name.trim(),
        description: description.trim() || undefined
      });
      await loadTopics();
      if (r?.id) setSelectedTopic(String(r.id));
      loadDashboard();
      return r;
    },
    [loadTopics, loadDashboard]
  );

  const addSource = useCallback(
    async (topicId: string, url: string, tags: string[]) =>
      run("sources", async () => {
        const r = await postJson("/learn", {
          topicId,
          url: url.trim(),
          tags: tags.length ? tags : undefined
        });
        loadSources(topicId);
        loadDashboard();
        return r;
      }),
    [run, loadSources, loadDashboard]
  );

  // Batch add: learn several resource URLs in one action by calling the existing
  // /learn endpoint per URL (sequentially, to respect rate limits). Each URL is
  // independent — a failing one does not abort the rest; per-URL results are
  // returned for display. The single-URL path keeps using addSource above.
  const addSources = useCallback(
    async (topicId: string, urls: string[], tags: string[]) =>
      run("sources", async () => {
        const results: Json[] = [];
        let saved = 0;
        let failed = 0;
        for (const raw of urls) {
          const url = raw.trim();
          if (!url) continue;
          try {
            const r = await postJson("/learn", {
              topicId,
              url,
              tags: tags.length ? tags : undefined
            });
            saved += 1;
            results.push({ url, ok: true, ...r });
          } catch (e: unknown) {
            failed += 1;
            results.push({ url, ok: false, error: errorPayload(e).error });
          }
        }
        loadSources(topicId);
        loadDashboard();
        return { status: "batch", total: results.length, saved, failed, results };
      }),
    [run, loadSources, loadDashboard]
  );

  // Re-ingest / refresh a source (dedupes chunks server-side). Falls back to
  // /learn if the dedicated endpoint is not available on the backend yet.
  const reingestSource = useCallback(
    async (source: Json) =>
      run(`reingest-${source.id}`, async () => {
        const id = String(source.id);
        try {
          const r = await postJson(`/sources/${id}/reingest`, {});
          loadSources(selectedTopic);
          loadDashboard();
          return r;
        } catch (e: unknown) {
          const code = errorPayload(e).error;
          if (code === "not_found" || code === "internal") {
            const r = await postJson("/learn", {
              topicId: String(source.topicId || selectedTopic),
              url: String(source.url),
              tags: Array.isArray(source.tags) ? source.tags : undefined
            });
            loadSources(selectedTopic);
            loadDashboard();
            return r;
          }
          throw e;
        }
      }),
    [run, loadSources, loadDashboard, selectedTopic]
  );

  const deleteSource = useCallback(
    async (id: string) =>
      run(`del-source-${id}`, async () => {
        const r = await delJson(`/sources/${id}`);
        loadSources(selectedTopic);
        loadDashboard();
        return r ?? { ok: true };
      }),
    [run, loadSources, loadDashboard, selectedTopic]
  );

  /* ---------------- skill actions ---------------- */
  const extractSkills = useCallback(
    async (topicId: string) =>
      run("skills", async () => {
        const r = await postJson("/extract-skills", { topicId });
        loadSkills();
        loadDashboard();
        return r;
      }),
    [run, loadSkills, loadDashboard]
  );

  const deleteSkill = useCallback(
    async (id: string) =>
      run(`del-skill-${id}`, async () => {
        const r = await delJson(`/skills/${id}`);
        loadSkills();
        loadDashboard();
        return r ?? { ok: true };
      }),
    [run, loadSkills, loadDashboard]
  );

  const updateSkill = useCallback(
    async (id: string, patch: Record<string, unknown>) =>
      run(`edit-skill-${id}`, async () => {
        const r = await patchJson(`/skills/${id}`, patch);
        loadSkills();
        return r ?? { ok: true };
      }),
    [run, loadSkills]
  );

  /* ---------------- project actions ---------------- */
  const createProject = useCallback(
    async (body: { name: string; description: string; stack?: string; repoUrl?: string }) =>
      run("projectCreate", async () => {
        const r = await postJson("/projects", body);
        loadProjects();
        loadDashboard();
        return r;
      }),
    [run, loadProjects, loadDashboard]
  );

  const updateProject = useCallback(
    async (id: string, patch: Record<string, unknown>) =>
      run(`edit-project-${id}`, async () => {
        const r = await patchJson(`/projects/${id}`, patch);
        loadProjects();
        return r ?? { ok: true };
      }),
    [run, loadProjects]
  );

  const deleteProject = useCallback(
    async (id: string) =>
      run(`del-project-${id}`, async () => {
        const r = await delJson(`/projects/${id}`);
        if (selectedProject === id) setSelectedProject("");
        loadProjects();
        loadDashboard();
        return r ?? { ok: true };
      }),
    [run, loadProjects, loadDashboard, selectedProject]
  );

  const connectGithub = useCallback(
    async (projectId: string, repoUrl: string) =>
      run(`gh-${projectId}`, async () => {
        const r = await postJson(`/projects/${projectId}/connect-github`, { repoUrl });
        loadProjects();
        loadDashboard();
        return r;
      }),
    [run, loadProjects, loadDashboard]
  );

  const saveGithubToken = useCallback(async (token: string) => {
    await postJson("/github-token", { token: token.trim() });
  }, []);

  const toggleSkill = useCallback((id: string) => {
    setSelectedSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const saveProjectSkills = useCallback(
    async (projectId: string, skillIds: string[]) =>
      run("saveSkills", async () => {
        const r = await patchJson(`/projects/${projectId}`, { skillIds });
        loadProjects();
        return { ...r, saved: true };
      }),
    [run, loadProjects]
  );

  /* ---------------- AI actions ---------------- */
  const ask = useCallback(
    async (question: string) => run("ask", () => postJson("/ask", { question, lang })),
    [run, lang]
  );

  const design = useCallback(
    async (projectId: string, section: string) =>
      run("design", () => postJson("/design", { projectId, section: section.trim() || undefined, lang })),
    [run, lang]
  );

  const generatePlan = useCallback(
    async (projectId: string, instructions: string) =>
      run("plan", async () => {
        const r = await postJson("/generate-plan", {
          projectId,
          instructions: instructions.trim() || undefined,
          lang
        });
        loadPlans(projectId);
        loadDashboard();
        return r;
      }),
    [run, loadPlans, loadDashboard, lang]
  );

  return {
    // i18n / prefs
    lang,
    setLang,
    theme,
    setTheme,
    rtl,
    t,
    // auth
    auth,
    authReady,
    loginUser,
    setLoginUser,
    loginPass,
    setLoginPass,
    loginErr,
    loginLoading,
    doLogin,
    logout,
    // nav
    active,
    setActive,
    // run state
    loading,
    output,
    run,
    // data
    stats,
    topics,
    sources,
    skills,
    projects,
    plans,
    ingesting,
    // selections
    selectedTopic,
    setSelectedTopic,
    selectedProject,
    setSelectedProject,
    selectedSkillIds,
    setSelectedSkillIds,
    toggleSkill,
    // loaders
    loadDashboard,
    loadTopics,
    loadSources,
    loadSkills,
    loadProjects,
    loadPlans,
    refreshAll,
    // actions
    createTopic,
    addSource,
    addSources,
    reingestSource,
    deleteSource,
    extractSkills,
    deleteSkill,
    updateSkill,
    createProject,
    updateProject,
    deleteProject,
    connectGithub,
    saveGithubToken,
    saveProjectSkills,
    ask,
    design,
    generatePlan
  };
}

export type GhostData = ReturnType<typeof useGhostData>;
