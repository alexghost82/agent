"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Json,
  ApiError,
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

// Live training/ingest progress surfaced in the Sources panel.
export type IngestItemStatus = "pending" | "learning" | "done" | "failed";
export interface IngestProgressItem {
  url: string;
  status: IngestItemStatus;
  chunks?: number;
  error?: string;
}
export interface IngestProgress {
  total: number;
  done: number;
  saved: number;
  failed: number;
  current: string | null;
  items: IngestProgressItem[];
}

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

  // Live phase of the in-flight autopilot run, polled from `agent_runs` while the
  // async /agent/run job executes, so the UI shows real progress (status + steps).
  const [agentRun, setAgentRun] = useState<Json | null>(null);

  // Live ingest/training progress for the Sources panel: per-URL status plus an
  // overall percentage, so the user sees which resource is being learned, how
  // many are done and how many remain. null when nothing is running/finished.
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);

  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<Json | null>(null);
  const [topics, setTopics] = useState<Json[]>([]);
  const [sources, setSources] = useState<Json[]>([]);
  const [skills, setSkills] = useState<Json[]>([]);
  const [projects, setProjects] = useState<Json[]>([]);
  const [plans, setPlans] = useState<Json[]>([]);
  const [builds, setBuilds] = useState<Json[]>([]);
  // Saved design decisions for the selected project (the "Design platform"
  // history). Loaded from GET /design?projectId=… so past designs persist.
  const [decisions, setDecisions] = useState<Json[]>([]);

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
    setDecisions([]);
    setAgentRun(null);
    setIngestProgress(null);
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
  const loadDecisions = useCallback(async (projectId: string) => {
    if (!projectId) {
      setDecisions([]);
      return;
    }
    try {
      setDecisions((await getJson(`/design?projectId=${encodeURIComponent(projectId)}`)).decisions || []);
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
    if (active === "overview") {
      loadDashboard();
      loadProjects();
    }
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
    if (active === "agents") {
      loadDashboard();
      loadProjects();
    }
  }, [active, auth, loadDashboard, loadTopics, loadSkills, loadProjects]);

  useEffect(() => {
    loadSources(selectedTopic);
  }, [selectedTopic, loadSources]);

  useEffect(() => {
    loadPlans(selectedProject);
    loadBuilds(selectedProject);
    loadDecisions(selectedProject);
    const p = projects.find((x) => String(x.id) === selectedProject);
    setSelectedSkillIds(Array.isArray(p?.skillIds) ? (p!.skillIds as string[]) : []);
  }, [selectedProject, projects, loadPlans, loadBuilds, loadDecisions]);

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

  const clearIngestProgress = useCallback(() => setIngestProgress(null), []);

  const addSource = useCallback(
    async (topicId: string, url: string, tags: string[], deep = false) =>
      run("sources", async () => {
        const u = url.trim();
        setIngestProgress({
          total: 1,
          done: 0,
          saved: 0,
          failed: 0,
          current: u,
          items: [{ url: u, status: "learning" }]
        });
        try {
          const r = await postJson("/learn", {
            topicId,
            url: u,
            tags: tags.length ? tags : undefined,
            deep: deep || undefined
          });
          setIngestProgress((p) =>
            p
              ? {
                  ...p,
                  done: 1,
                  saved: 1,
                  current: null,
                  items: [{ url: u, status: "done", chunks: Number((r as Json)?.chunks ?? 0) }]
                }
              : p
          );
          loadSources(topicId);
          loadDashboard();
          return r;
        } catch (e: unknown) {
          const error = errorPayload(e).error;
          setIngestProgress((p) =>
            p ? { ...p, done: 1, failed: 1, current: null, items: [{ url: u, status: "failed", error }] } : p
          );
          throw e;
        }
      }),
    [run, loadSources, loadDashboard]
  );

  // Batch add: learn several resource URLs in one action by calling the existing
  // /learn endpoint per URL (sequentially, to respect rate limits). Each URL is
  // independent — a failing one does not abort the rest; per-URL results are
  // returned for display. Live per-URL progress drives `ingestProgress` so the
  // panel can show a percentage bar and which resource is currently learning.
  const addSources = useCallback(
    async (topicId: string, urls: string[], tags: string[], deep = false) =>
      run("sources", async () => {
        const clean = urls.map((u) => u.trim()).filter(Boolean);
        setIngestProgress({
          total: clean.length,
          done: 0,
          saved: 0,
          failed: 0,
          current: null,
          items: clean.map((u) => ({ url: u, status: "pending" as IngestItemStatus }))
        });
        const results: Json[] = [];
        let saved = 0;
        let failed = 0;
        for (let i = 0; i < clean.length; i++) {
          const url = clean[i];
          setIngestProgress((p) =>
            p
              ? {
                  ...p,
                  current: url,
                  items: p.items.map((it, idx) => (idx === i ? { ...it, status: "learning" } : it))
                }
              : p
          );
          try {
            const r = await postJson("/learn", {
              topicId,
              url,
              tags: tags.length ? tags : undefined,
              deep: deep || undefined
            });
            saved += 1;
            results.push({ url, ok: true, ...r });
            const chunks = Number((r as Json)?.chunks ?? 0);
            setIngestProgress((p) =>
              p
                ? {
                    ...p,
                    done: p.done + 1,
                    saved: p.saved + 1,
                    current: null,
                    items: p.items.map((it, idx) => (idx === i ? { ...it, status: "done", chunks } : it))
                  }
                : p
            );
          } catch (e: unknown) {
            failed += 1;
            const error = errorPayload(e).error;
            results.push({ url, ok: false, error });
            setIngestProgress((p) =>
              p
                ? {
                    ...p,
                    done: p.done + 1,
                    failed: p.failed + 1,
                    current: null,
                    items: p.items.map((it, idx) => (idx === i ? { ...it, status: "failed", error } : it))
                  }
                : p
            );
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

  /* ---------------- async AI job polling ---------------- */
  // Plan / build / design / skills are async on the server (Cloud Tasks): the
  // POST only enqueues a job and returns { jobId } so it never hits Firebase
  // Hosting's 60s rewrite timeout. We poll the job here until it finishes; the
  // surrounding `run(...)` keeps the panel in its loading state for the whole
  // wait, so no panel changes are needed.
  const pollAiJob = useCallback(async (jobId: string): Promise<Json> => {
    const deadline = Date.now() + 12 * 60 * 1000; // generous cap (~12 min)
    for (;;) {
      const j = await getJson(`/ai-jobs/${encodeURIComponent(jobId)}`);
      const status = String(j?.status || "");
      if (status === "done") return (j?.result as Json) || {};
      if (status === "error") throw new ApiError(400, String(j?.errorCode || "internal"));
      if (Date.now() > deadline) throw new ApiError(504, "internal");
      await new Promise((r) => setTimeout(r, 2500));
    }
  }, []);

  /* ---------------- skill actions ---------------- */
  // Skill extraction fans out across several batched LLM calls and routinely
  // exceeds Firebase Hosting's 60s rewrite timeout, so the server now only
  // enqueues a job and returns { jobId }. We poll it to completion (mirroring
  // plan/design/build) instead of letting the rewrite time out — which used to
  // surface a spurious "server error" even though skills were saved in the
  // background (they only showed up after a manual reload).
  const extractSkills = useCallback(
    async (topicId: string) =>
      run("skills", async () => {
        const { jobId } = await postJson("/extract-skills", { topicId });
        const r = await pollAiJob(String(jobId));
        loadSkills();
        loadDashboard();
        return r;
      }),
    [run, pollAiJob, loadSkills, loadDashboard]
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
      run("design", async () => {
        const { jobId } = await postJson("/design", {
          projectId,
          section: section.trim() || undefined,
          topicIds: topicIds && topicIds.length ? topicIds : undefined,
          lang
        });
        const r = await pollAiJob(String(jobId));
        // Persist into the Design history list and refresh KPIs.
        loadDecisions(projectId);
        loadDashboard();
        return r;
      }),
    [run, pollAiJob, lang, loadDecisions, loadDashboard]
  );

  const generatePlan = useCallback(
    async (projectId: string, instructions: string) =>
      run("plan", async () => {
        const { jobId } = await postJson("/generate-plan", {
          projectId,
          instructions: instructions.trim() || undefined,
          lang
        });
        const r = await pollAiJob(String(jobId));
        loadPlans(projectId);
        loadDashboard();
        return r;
      }),
    [run, pollAiJob, loadPlans, loadDashboard, lang]
  );

  const build = useCallback(
    async (projectId: string, planId: string, instructions: string) =>
      run("build", async () => {
        const { jobId } = await postJson(`/projects/${projectId}/build`, {
          planId: planId || undefined,
          instructions: instructions.trim() || undefined,
          lang
        });
        // The build job result is compact (no inlined files, to stay under
        // Firestore's 1 MB doc limit); load the full run + artifacts so the
        // panel can render/zip the generated files.
        const res = await pollAiJob(String(jobId));
        let files: Json[] = [];
        let summary = String(res?.summary || "");
        let verification = res?.verification;
        const runId = String(res?.id || "");
        if (runId) {
          try {
            const full = await getJson(`/builds/${encodeURIComponent(runId)}`);
            const artifacts = Array.isArray(full?.artifacts) ? (full.artifacts as Json[]) : [];
            files = artifacts.map((a) => ({ path: String(a.path), content: String(a.content) }));
            if (full?.run) {
              summary = String((full.run as Json)?.summary ?? summary);
              verification = (full.run as Json)?.verification ?? verification;
            }
          } catch {
            /* fall back to the compact job result if the fetch fails */
          }
        }
        loadBuilds(projectId);
        loadDashboard();
        return { id: runId, status: "ready", files, summary, verification };
      }),
    [run, pollAiJob, loadBuilds, loadDashboard, lang]
  );

  const openBuild = useCallback(
    async (id: string) => run("buildOpen", () => getJson(`/builds/${encodeURIComponent(id)}`)),
    [run]
  );

  /* ---------------- autonomous agent (Autopilot) ---------------- */
  // /agent/run is async on the server (Cloud Tasks): the POST only enqueues and
  // returns { runId }, and the heavy learn → skills → design → plan → verified
  // build cycle runs out of band so it never hits Firebase Hosting's 60s rewrite
  // timeout. We poll the run doc for live progress (status + steps) until it
  // finishes, then load the verified build files so the panel can render/zip
  // them. The surrounding `run("agent", …)` keeps the panel in its loading state
  // (and `agentRun` drives the live stepper) for the whole wait.
  const runAgent = useCallback(
    async (urls: string[], task: string, deep: boolean) =>
      run("agent", async () => {
        const cleanUrls = urls.map((u) => u.trim()).filter(Boolean);
        setAgentRun(null);
        const { runId } = await postJson("/agent/run", {
          urls: cleanUrls,
          task: task.trim(),
          deep: deep || undefined,
          lang
        });
        const id = String(runId);

        // Poll the run doc until it reaches a terminal phase.
        const deadline = Date.now() + 15 * 60 * 1000; // generous cap (~15 min)
        let runDoc: Json = {};
        for (;;) {
          try {
            const r = await getJson(`/agent/runs/${encodeURIComponent(id)}`);
            runDoc = (r.run as Json) || {};
            setAgentRun(runDoc);
          } catch {
            /* polling is best-effort */
          }
          const status = String(runDoc?.status || "");
          if (status === "ready") break;
          if (status === "error") throw new ApiError(400, String(runDoc?.errorCode || "internal"));
          if (Date.now() > deadline) throw new ApiError(504, "internal");
          await new Promise((r2) => setTimeout(r2, 2000));
        }

        // Load the verified build files (kept out of the run doc to stay under
        // Firestore's 1 MB limit) for display/zip.
        let files: Json[] = [];
        const buildRunId = String(runDoc?.buildRunId || "");
        if (buildRunId) {
          try {
            const full = await getJson(`/builds/${encodeURIComponent(buildRunId)}`);
            const artifacts = Array.isArray(full?.artifacts) ? (full.artifacts as Json[]) : [];
            files = artifacts.map((a) => ({ path: String(a.path), content: String(a.content) }));
          } catch {
            /* fall back to no inlined files if the fetch fails */
          }
        }

        // The run materialized a topic/project/build — refresh the lists.
        loadTopics();
        loadProjects();
        loadDashboard();
        return {
          runId: id,
          topicId: runDoc?.topicId ?? null,
          projectId: runDoc?.projectId ?? null,
          buildRunId: buildRunId || null,
          steps: Array.isArray(runDoc?.steps) ? runDoc.steps : [],
          summary: String(runDoc?.summary || ""),
          verification: runDoc?.verification ?? null,
          files
        };
      }),
    [run, lang, loadTopics, loadProjects, loadDashboard]
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
    // global search
    query,
    setQuery,
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
    builds,
    decisions,
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
    loadDecisions,
    refreshAll,
    // actions
    createTopic,
    addSource,
    addSources,
    ingestProgress,
    clearIngestProgress,
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
    // autonomous agent (Autopilot)
    agentRun,
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
