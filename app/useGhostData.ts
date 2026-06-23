"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Json,
  errorPayload,
  getJson,
  postJson,
  patchJson,
  putJson,
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

  // Live phase of the in-flight autopilot run (polled from agent_runs while the
  // blocking /agent/run call is still resolving), so the UI shows real progress.
  const [agentRun, setAgentRun] = useState<Json | null>(null);
  const agentBaselineRef = useRef<string | null>(null);

  const [stats, setStats] = useState<Json | null>(null);
  const [topics, setTopics] = useState<Json[]>([]);
  const [sources, setSources] = useState<Json[]>([]);
  const [skills, setSkills] = useState<Json[]>([]);
  const [projects, setProjects] = useState<Json[]>([]);
  const [plans, setPlans] = useState<Json[]>([]);
  const [builds, setBuilds] = useState<Json[]>([]);

  const [selectedTopic, setSelectedTopic] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  // Design Map (per-project graph editor). Distinct from the flow_maps handled
  // by loadMap/saveMap above — these are keyed by projectId.
  const [designMaps, setDesignMaps] = useState<Record<string, Json>>({});
  const [selectedDesignMapProject, setSelectedDesignMapProject] = useState("");

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
    setBuilds([]);
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
  const loadBuilds = useCallback(async (projectId: string) => {
    if (!projectId) {
      setBuilds([]);
      return;
    }
    try {
      setBuilds((await getJson(`/builds?projectId=${encodeURIComponent(projectId)}`)).runs || []);
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
    if (active === "design" || active === "plan" || active === "build") loadProjects();
  }, [active, auth, loadDashboard, loadTopics, loadSkills, loadProjects]);

  useEffect(() => {
    loadSources(selectedTopic);
  }, [selectedTopic, loadSources]);

  useEffect(() => {
    loadPlans(selectedProject);
    loadBuilds(selectedProject);
    const p = projects.find((x) => String(x.id) === selectedProject);
    setSelectedSkillIds(Array.isArray(p?.skillIds) ? (p!.skillIds as string[]) : []);
  }, [selectedProject, projects, loadPlans, loadBuilds]);

  /* ---------------- ingest + scan progress polling ---------------- */
  const ingesting = useMemo(
    () => projects.some((p) => String(p.ingestStatus || "") === "ingesting"),
    [projects]
  );
  // A project-intelligence scan is in flight while its mirrored status is queued
  // / scanning / analyzing — poll so the card + progress bar update live.
  const scanning = useMemo(
    () => projects.some((p) => ["queued", "scanning", "analyzing"].includes(String(p.scanStatus || ""))),
    [projects]
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!auth || (!ingesting && !scanning)) {
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
  }, [auth, ingesting, scanning, loadProjects, loadDashboard]);

  /* ---------------- live agent-run progress polling ---------------- */
  // While /agent/run is in flight, poll the run list and lock onto the newest
  // run that did not exist before we started (vs. the captured baseline). The
  // server streams real phase transitions into that doc (status + steps).
  useEffect(() => {
    if (!auth || !loading.agent) {
      setAgentRun(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await getJson("/agent/runs");
        const runs = (r.runs || []) as Json[];
        const newest = runs[0] || null;
        const live = newest && String(newest.id) !== agentBaselineRef.current ? newest : null;
        if (!cancelled) setAgentRun(live);
      } catch {
        /* polling is best-effort */
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [auth, loading.agent]);

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
    async (topicId: string, url: string, tags: string[], deep = false) =>
      run("sources", async () => {
        const r = await postJson("/learn", {
          topicId,
          url: url.trim(),
          tags: tags.length ? tags : undefined,
          deep: deep || undefined
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
    async (topicId: string, urls: string[], tags: string[], deep = false) =>
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
              tags: tags.length ? tags : undefined,
              deep: deep || undefined
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
    async (projectId: string, section: string, topicIds?: string[]) =>
      run("design", () =>
        postJson("/design", {
          projectId,
          section: section.trim() || undefined,
          topicIds: topicIds && topicIds.length ? topicIds : undefined,
          lang
        })
      ),
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

  const build = useCallback(
    async (projectId: string, planId: string, instructions: string) =>
      run("build", async () => {
        const r = await postJson(`/projects/${projectId}/build`, {
          planId: planId || undefined,
          instructions: instructions.trim() || undefined,
          lang
        });
        loadBuilds(projectId);
        loadDashboard();
        return r;
      }),
    [run, loadBuilds, loadDashboard, lang]
  );

  const openBuild = useCallback(
    async (id: string) => run("buildOpen", () => getJson(`/builds/${encodeURIComponent(id)}`)),
    [run]
  );

  /* ---------------- autonomous agent (Epic 3) ---------------- */
  const runAgent = useCallback(
    async (urls: string[], task: string, deep: boolean) =>
      run("agent", async () => {
        const cleanUrls = urls.map((u) => u.trim()).filter(Boolean);
        // Remember the newest existing run so the poller can identify the new one.
        try {
          const existing = await getJson("/agent/runs");
          const top = (existing.runs as Json[] | undefined)?.[0];
          agentBaselineRef.current = top?.id ? String(top.id) : null;
        } catch {
          agentBaselineRef.current = null;
        }
        setAgentRun(null);
        const r = await postJson("/agent/run", {
          urls: cleanUrls,
          task: task.trim(),
          deep: deep || undefined,
          lang
        });
        // The run materialized a topic/project/build — refresh the lists.
        loadTopics();
        loadProjects();
        loadDashboard();
        return r;
      }),
    [run, loadTopics, loadProjects, loadDashboard, lang]
  );

  const loadAgentRun = useCallback(
    async (id: string) => run("agentRun", () => getJson(`/agent/runs/${encodeURIComponent(id)}`)),
    [run]
  );

  /* ---------------- flow maps (Stage 1) ---------------- */
  const loadMap = useCallback(
    async (projectId: string, kind: "design" | "project"): Promise<Json | null> => {
      try {
        const r = await getJson(`/projects/${projectId}/map?kind=${kind}`);
        return (r.map as Json | null) ?? null;
      } catch {
        return null;
      }
    },
    []
  );

  const saveMap = useCallback(
    async (projectId: string, kind: "design" | "project", nodes: Json[], edges: Json[]): Promise<Json> =>
      putJson(`/projects/${projectId}/map`, { kind, nodes, edges }),
    []
  );

  /* ---------------- design map (per-project graph editor) ---------------- */
  const loadDesignMap = useCallback(async (projectId: string): Promise<Json | null> => {
    try {
      const r = await getJson(`/projects/${projectId}/design-map`);
      const map = (r.map as Json | null) ?? null;
      if (map) setDesignMaps((m) => ({ ...m, [projectId]: map }));
      return map;
    } catch {
      return null;
    }
  }, []);

  const saveDesignMap = useCallback(
    async (projectId: string, map: { nodes: unknown[]; edges: unknown[] }): Promise<Json> => {
      const r = await postJson(`/projects/${projectId}/design-map`, {
        nodes: map.nodes,
        edges: map.edges
      });
      if (r.map) setDesignMaps((m) => ({ ...m, [projectId]: r.map as Json }));
      return r;
    },
    []
  );

  const patchDesignMap = useCallback(
    async (projectId: string, patch: { nodes?: unknown[]; edges?: unknown[] }): Promise<Json> => {
      const r = await patchJson(`/projects/${projectId}/design-map`, patch);
      if (r.map) setDesignMaps((m) => ({ ...m, [projectId]: r.map as Json }));
      return r;
    },
    []
  );

  const addSkillToDesignMap = useCallback(
    async (projectId: string, skillId: string, position?: { x: number; y: number }): Promise<Json> => {
      const r = await postJson(`/projects/${projectId}/design-map/add-skill`, { skillId, position });
      if (r.map) setDesignMaps((m) => ({ ...m, [projectId]: r.map as Json }));
      return r;
    },
    []
  );

  const addPodskillToDesignMap = useCallback(
    async (
      projectId: string,
      skillId: string,
      podskillId: string,
      position?: { x: number; y: number }
    ): Promise<Json> => {
      const r = await postJson(`/projects/${projectId}/design-map/add-podskill`, {
        skillId,
        podskillId,
        position
      });
      if (r.map) setDesignMaps((m) => ({ ...m, [projectId]: r.map as Json }));
      return r;
    },
    []
  );

  /* ---------------- project intelligence (scan + map) ---------------- */
  // Enqueue a (read-only) project scan. The heavy analysis runs server-side; we
  // refresh the project list so the mirrored scanStatus updates the card.
  const startScan = useCallback(
    async (projectId: string, options?: { depth?: number; ai?: boolean }) =>
      run(`scan-${projectId}`, async () => {
        const r = await postJson(`/projects/${projectId}/scan`, options || {});
        loadProjects();
        return r;
      }),
    [run, loadProjects]
  );

  const rescan = useCallback(
    async (projectId: string, options?: { depth?: number; ai?: boolean }) =>
      run(`scan-${projectId}`, async () => {
        const r = await postJson(`/projects/${projectId}/rescan`, options || {});
        loadProjects();
        return r;
      }),
    [run, loadProjects]
  );

  const loadScanStatus = useCallback(async (projectId: string): Promise<Json | null> => {
    try {
      const r = await getJson(`/projects/${projectId}/scan`);
      return (r.scan as Json | null) ?? null;
    } catch {
      return null;
    }
  }, []);

  const loadIntelMap = useCallback(async (projectId: string): Promise<Json | null> => {
    try {
      const r = await getJson(`/projects/${projectId}/scan/map`);
      return (r.map as Json | null) ?? null;
    } catch {
      return null;
    }
  }, []);

  const loadNodeDetail = useCallback(
    async (projectId: string, nodeId: string): Promise<Json | null> => {
      try {
        const r = await getJson(`/projects/${projectId}/nodes/${encodeURIComponent(nodeId)}`);
        return (r.node as Json | null) ?? null;
      } catch {
        return null;
      }
    },
    []
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
    agentRun,
    // data
    stats,
    topics,
    sources,
    skills,
    projects,
    plans,
    builds,
    ingesting,
    scanning,
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
    loadBuilds,
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
    generatePlan,
    build,
    openBuild,
    runAgent,
    loadAgentRun,
    loadMap,
    saveMap,
    // design map
    designMaps,
    selectedDesignMapProject,
    setSelectedDesignMapProject,
    loadDesignMap,
    saveDesignMap,
    patchDesignMap,
    addSkillToDesignMap,
    addPodskillToDesignMap,
    startScan,
    rescan,
    loadScanStatus,
    loadIntelMap,
    loadNodeDetail
  };
}

export type GhostData = ReturnType<typeof useGhostData>;
