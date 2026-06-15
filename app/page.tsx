"use client";

import { useCallback, useEffect, useState } from "react";
import "./styles.css";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
type Json = Record<string, unknown>;
type Lang = "en" | "he";
type Theme = "dark" | "light";

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function getJson(path: string) {
  const res = await fetch(`${API_BASE}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const STEP_KEYS = ["overview", "learn", "skills", "project", "ask", "plan", "generate", "tasks", "approvals", "review"] as const;
type StepKey = typeof STEP_KEYS[number];
const STEP_META: Record<StepKey, { n: string; icon: string }> = {
  overview: { n: "•", icon: "overview" }, learn: { n: "1", icon: "learn" }, skills: { n: "2", icon: "skills" },
  project: { n: "3", icon: "project" }, ask: { n: "4", icon: "ask" }, plan: { n: "5", icon: "plan" },
  generate: { n: "6", icon: "generate" }, tasks: { n: "7", icon: "tasks" }, approvals: { n: "8", icon: "approvals" }, review: { n: "9", icon: "review" }
};

const DICT: Record<Lang, any> = {
  en: {
    brandSub: "Self-learning AI dev agent",
    workflow: "Workflow (in order)", refresh: "Refresh", step: "Step",
    statLabels: { sources: "Sources", knowledge_chunks: "Knowledge", agent_skills: "Skills", projects: "Projects", feature_plans: "Feature plans", project_decisions: "Decisions", build_tasks: "Tasks", approvals: "Approvals", generated_code: "Code plans", agent_logs: "Logs" },
    miniSources: "sources", miniSkills: "skills", miniApprovals: "approvals",
    recentTitle: "Recent agent activity", noEvents: "No events yet. Start at step 1 — add a source.",
    steps: {
      overview: { title: "Overview", hint: "Memory state and the agent's latest actions" },
      learn: { title: "Sources", hint: "Add websites — the agent studies and remembers them" },
      skills: { title: "Skills", hint: "Skills the agent extracted from what it learned" },
      project: { title: "My Project", hint: "Add your project and request features built from skills" },
      ask: { title: "Ask memory", hint: "Ask about what the agent already learned" },
      plan: { title: "Design platform", hint: "Design a platform from memory" },
      generate: { title: "Generate code", hint: "Generate a code plan with approval" },
      tasks: { title: "Tasks", hint: "Backlog of tasks for the agent" },
      approvals: { title: "Approvals", hint: "Approve or reject agent actions" },
      review: { title: "Review", hint: "Code review and security review" }
    },
    learnExplain: "Paste a website or docs URL. The agent fetches the page, splits it into chunks, builds embeddings and stores it in memory. Add as many sources as you want.",
    urlLabel: "Source URL", topicLabel: "Topic (optional)", tagsLabel: "Tags (comma separated)",
    addSource: "Add & learn", learning: "Learning…", learnedSources: "Learned sources", refreshList: "Refresh list", noSources: "No sources yet. Add the first one above.", chunksUnit: "chunks",
    skillsExplain: "After learning, the agent can distill reusable engineering skills from its memory. Extract them here, then use them to build features for your project.",
    skillTopic: "Topic to focus on (optional)", extractSkills: "Extract skills from memory", extracting: "Extracting…", mySkills: "Agent skills", noSkills: "No skills yet. Learn sources, then extract skills.", exampleLabel: "Example",
    projectExplain: "Add your project, then request a specific feature. The agent combines your project context, memory and extracted skills to propose an implementation plan (with approval).",
    nameLabel: "Project name", descLabel: "Description", stackLabel: "Stack (optional)", repoLabel: "Repo URL (optional)", createProject: "Create project", noProjects: "No projects yet. Create one above.",
    selectProject: "Select project", featureLabel: "Feature to develop", developFeature: "Propose implementation plan", developing: "Designing…", skillsUsedLabel: "skills used", featurePlansTitle: "Implementation plans",
    askExplain: "The agent finds relevant chunks in memory (semantic search) and answers with sources, risks and the next step.",
    questionLabel: "Question", ask: "Ask memory", thinking: "Thinking…",
    planExplain: "From memory the agent designs a platform: goals, roles, modules, DB, API, screens, security model, risks and an MVP plan. Then it self-reviews (critic).",
    ideaLabel: "Platform idea", designPlan: "Design + Critic", planning: "Designing…",
    genExplain: "The agent generates a file structure and code plan and creates an approval. Code is NOT applied automatically — you confirm it at step 8.",
    taskFieldLabel: "Task", generate: "Generate + Approval", generating: "Generating…",
    tasksExplain: "Create tasks for the agent backlog. Below is the list of recent tasks with their status.",
    titleLabel: "Title", priorityLabel: "Priority", createTask: "Create task", tasksList: "Tasks", noTasks: "No tasks yet.",
    approvalsExplain: "Requests for agent actions. Nothing runs until you confirm. Review the critic analysis and decide.",
    approvalsList: "Requests", approve: "Approve", reject: "Reject", noApprovals: "No requests yet. They are created at step 6 (generate code) and step 3 (features).",
    reviewExplain: "Paste code, architecture or a plan — the agent runs a code review or a security review (auth, secrets, leaks, SSRF, prompt injection, etc.).",
    contentLabel: "Content to review", codeReview: "Code Review", secReview: "Security Review",
    working: "Agent is working…", resultEmpty: "Result will appear here.", errorWord: "Error", showRaw: "Show raw JSON", approvalCreated: "Approval created",
    resultLabels: { answer: "Answer", plan: "Implementation plan", critic: "Critic check", codePlan: "Code plan", review: "Review", result: "Result" },
    login: { title: "Sign in to continue", username: "Username", password: "Password", signIn: "Sign in", signingIn: "Signing in…", error: "Invalid username or password", logout: "Log out" }
  },
  he: {
    brandSub: "סוכן פיתוח לומד מבוסס AI",
    workflow: "תהליך עבודה (לפי הסדר)", refresh: "רענון", step: "שלב",
    statLabels: { sources: "מקורות", knowledge_chunks: "ידע", agent_skills: "כישורים", projects: "פרויקטים", feature_plans: "תוכניות יכולת", project_decisions: "החלטות", build_tasks: "משימות", approvals: "אישורים", generated_code: "תוכניות קוד", agent_logs: "יומנים" },
    miniSources: "מקורות", miniSkills: "כישורים", miniApprovals: "אישורים",
    recentTitle: "פעולות אחרונות של הסוכן", noEvents: "אין אירועים עדיין. התחילו בשלב 1 — הוסיפו מקור.",
    steps: {
      overview: { title: "סקירה", hint: "מצב הזיכרון והפעולות האחרונות של הסוכן" },
      learn: { title: "מקורות", hint: "הוסיפו אתרים — הסוכן ילמד ויזכור אותם" },
      skills: { title: "כישורים", hint: "כישורים שהסוכן הפיק ממה שלמד" },
      project: { title: "הפרויקט שלי", hint: "הוסיפו פרויקט ובקשו פיתוח יכולות מתוך הכישורים" },
      ask: { title: "שאלה לזיכרון", hint: "שאלו על מה שהסוכן כבר למד" },
      plan: { title: "תכנון פלטפורמה", hint: "תכננו פלטפורמה מתוך הזיכרון" },
      generate: { title: "יצירת קוד", hint: "צרו תוכנית קוד עם אישור" },
      tasks: { title: "משימות", hint: "רשימת משימות לסוכן" },
      approvals: { title: "אישורים", hint: "אשרו או דחו פעולות של הסוכן" },
      review: { title: "סקירה", hint: "סקירת קוד וסקירת אבטחה" }
    },
    learnExplain: "הדביקו כתובת אתר או תיעוד. הסוכן יוריד את העמוד, יחלק אותו למקטעים, יבנה embeddings וישמור בזיכרון. הוסיפו כמה מקורות שתרצו.",
    urlLabel: "כתובת המקור", topicLabel: "נושא (לא חובה)", tagsLabel: "תגיות (מופרדות בפסיק)",
    addSource: "הוסף ולמד", learning: "לומד…", learnedSources: "מקורות שנלמדו", refreshList: "רענן רשימה", noSources: "אין מקורות עדיין. הוסיפו את הראשון למעלה.", chunksUnit: "מקטעים",
    skillsExplain: "לאחר הלמידה הסוכן יכול להפיק כישורים הנדסיים לשימוש חוזר מתוך הזיכרון. הפיקו אותם כאן, ואז השתמשו בהם לבניית יכולות לפרויקט שלכם.",
    skillTopic: "נושא להתמקדות (לא חובה)", extractSkills: "הפק כישורים מהזיכרון", extracting: "מפיק…", mySkills: "כישורי הסוכן", noSkills: "אין כישורים עדיין. למדו מקורות ואז הפיקו כישורים.", exampleLabel: "דוגמה",
    projectExplain: "הוסיפו את הפרויקט שלכם ובקשו יכולת מסוימת. הסוכן משלב את הקשר הפרויקט, הזיכרון והכישורים כדי להציע תוכנית מימוש (עם אישור).",
    nameLabel: "שם הפרויקט", descLabel: "תיאור", stackLabel: "סטאק (לא חובה)", repoLabel: "כתובת ריפו (לא חובה)", createProject: "צור פרויקט", noProjects: "אין פרויקטים עדיין. צרו אחד למעלה.",
    selectProject: "בחר פרויקט", featureLabel: "יכולת לפיתוח", developFeature: "הצע תוכנית מימוש", developing: "מתכנן…", skillsUsedLabel: "כישורים בשימוש", featurePlansTitle: "תוכניות מימוש",
    askExplain: "הסוכן מוצא מקטעים רלוונטיים בזיכרון (חיפוש סמנטי) ועונה עם מקורות, סיכונים והצעד הבא.",
    questionLabel: "שאלה", ask: "שאל את הזיכרון", thinking: "חושב…",
    planExplain: "מהזיכרון הסוכן מתכנן פלטפורמה: מטרות, תפקידים, מודולים, מסד נתונים, API, מסכים, מודל אבטחה, סיכונים ותוכנית MVP. לאחר מכן מבצע ביקורת עצמית.",
    ideaLabel: "רעיון הפלטפורמה", designPlan: "תכנן + ביקורת", planning: "מתכנן…",
    genExplain: "הסוכן יוצר מבנה קבצים ותוכנית קוד ויוצר בקשת אישור. הקוד אינו מיושם אוטומטית — אתם מאשרים בשלב 8.",
    taskFieldLabel: "משימה", generate: "צור + אישור", generating: "יוצר…",
    tasksExplain: "צרו משימות לרשימת הסוכן. למטה רשימת המשימות האחרונות עם הסטטוס שלהן.",
    titleLabel: "כותרת", priorityLabel: "עדיפות", createTask: "צור משימה", tasksList: "משימות", noTasks: "אין משימות עדיין.",
    approvalsExplain: "בקשות לפעולות הסוכן. דבר אינו מתבצע עד שתאשרו. עיינו בניתוח הביקורת והחליטו.",
    approvalsList: "בקשות", approve: "אשר", reject: "דחה", noApprovals: "אין בקשות עדיין. הן נוצרות בשלב 6 (יצירת קוד) ובשלב 3 (יכולות).",
    reviewExplain: "הדביקו קוד, ארכיטקטורה או תוכנית — הסוכן יבצע סקירת קוד או סקירת אבטחה (הרשאות, סודות, דליפות, SSRF, prompt injection וכו').",
    contentLabel: "תוכן לסקירה", codeReview: "סקירת קוד", secReview: "סקירת אבטחה",
    working: "הסוכן עובד…", resultEmpty: "התוצאה תופיע כאן.", errorWord: "שגיאה", showRaw: "הצג JSON גולמי", approvalCreated: "נוצר אישור",
    resultLabels: { answer: "תשובה", plan: "תוכנית מימוש", critic: "בדיקת ביקורת", codePlan: "תוכנית קוד", review: "סקירה", result: "תוצאה" },
    login: { title: "התחברו כדי להמשיך", username: "שם משתמש", password: "סיסמה", signIn: "התחבר", signingIn: "מתחבר…", error: "שם משתמש או סיסמה שגויים", logout: "התנתק" }
  }
};

function Icon({ name }: { name: string }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<string, React.ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></>,
    learn: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
    skills: <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></>,
    project: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>,
    ask: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>,
    plan: <><path d="M3 3v18h18" /><path d="m7 14 4-4 3 3 5-6" /></>,
    generate: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
    tasks: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
    approvals: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
    review: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
    refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>
  };
  return <svg {...common} aria-hidden>{paths[name] || paths.overview}</svg>;
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
  const [sources, setSources] = useState<Json[]>([]);
  const [skills, setSkills] = useState<Json[]>([]);
  const [projects, setProjects] = useState<Json[]>([]);
  const [featurePlans, setFeaturePlans] = useState<Json[]>([]);
  const [tasks, setTasks] = useState<Json[]>([]);
  const [approvals, setApprovals] = useState<Json[]>([]);

  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTopic, setSourceTopic] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [skillTopic, setSkillTopic] = useState("");
  const [pName, setPName] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pStack, setPStack] = useState("");
  const [pRepo, setPRepo] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [feature, setFeature] = useState("");
  const [question, setQuestion] = useState("");
  const [idea, setIdea] = useState("");
  const [codeTask, setCodeTask] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPriority, setTaskPriority] = useState("medium");
  const [reviewContent, setReviewContent] = useState("");

  const t = DICT[lang];
  const rtl = lang === "he";

  useEffect(() => {
    const savedLang = (localStorage.getItem("ghost.lang") as Lang) || "en";
    const savedTheme = (localStorage.getItem("ghost.theme") as Theme) || "dark";
    setLang(savedLang); setTheme(savedTheme);
    const savedAuth = localStorage.getItem("ghost.auth");
    if (savedAuth) { try { setAuth(JSON.parse(savedAuth)); } catch { /* */ } }
    setAuthReady(true);
  }, []);

  async function doLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setLoginErr(""); setLoginLoading(true);
    try {
      const r = await postJson("/login", { username: loginUser.trim(), password: loginPass });
      const a = { username: r.user.username, token: r.token };
      localStorage.setItem("ghost.auth", JSON.stringify(a));
      setAuth(a); setLoginPass("");
    } catch (e: any) { setLoginErr(e.message || t.login.error); }
    finally { setLoginLoading(false); }
  }
  function logout() { localStorage.removeItem("ghost.auth"); setAuth(null); setActive("overview"); }
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
    localStorage.setItem("ghost.lang", lang);
    localStorage.setItem("ghost.theme", theme);
  }, [lang, theme]);

  const run = useCallback(async (key: string, action: () => Promise<Json>) => {
    setLoading((l) => ({ ...l, [key]: true }));
    setOutput((o) => ({ ...o, [key]: null }));
    try { const res = await action(); setOutput((o) => ({ ...o, [key]: res })); return res; }
    catch (e: any) { setOutput((o) => ({ ...o, [key]: { error: e.message } })); return null; }
    finally { setLoading((l) => ({ ...l, [key]: false })); }
  }, []);

  const loadDashboard = useCallback(async () => { try { setStats(await getJson("/dashboard")); } catch { /* */ } }, []);
  const loadSources = useCallback(async () => { try { setSources((await getJson("/sources")).sources || []); } catch { /* */ } }, []);
  const loadSkills = useCallback(async () => { try { setSkills((await getJson("/skills")).skills || []); } catch { /* */ } }, []);
  const loadProjects = useCallback(async () => { try { setProjects((await getJson("/projects")).projects || []); } catch { /* */ } }, []);
  const loadFeaturePlans = useCallback(async () => { try { setFeaturePlans((await getJson("/feature-plans")).featurePlans || []); } catch { /* */ } }, []);
  const loadTasks = useCallback(async () => { try { setTasks((await getJson("/tasks")).tasks || []); } catch { /* */ } }, []);
  const loadApprovals = useCallback(async () => { try { setApprovals((await getJson("/approvals")).approvals || []); } catch { /* */ } }, []);

  useEffect(() => { loadDashboard(); loadSources(); }, [loadDashboard, loadSources]);
  useEffect(() => {
    if (active === "overview") loadDashboard();
    if (active === "skills") loadSkills();
    if (active === "project") { loadProjects(); loadFeaturePlans(); }
    if (active === "tasks") loadTasks();
    if (active === "approvals") loadApprovals();
  }, [active, loadDashboard, loadSkills, loadProjects, loadFeaturePlans, loadTasks, loadApprovals]);

  async function addSource() {
    if (!sourceUrl.trim()) return;
    const tags = sourceTags.split(",").map((x) => x.trim()).filter(Boolean);
    await run("learn", () => postJson("/learn", { url: sourceUrl.trim(), topic: sourceTopic.trim() || undefined, tags: tags.length ? tags : undefined }));
    setSourceUrl(""); setSourceTopic(""); setSourceTags(""); loadSources(); loadDashboard();
  }
  async function extractSkills() {
    await run("skills", async () => { const r = await postJson("/extract-skills", { topic: skillTopic.trim() || undefined }); loadSkills(); loadDashboard(); return r; });
  }
  async function createProject() {
    await run("project", async () => { const r = await postJson("/projects", { name: pName, description: pDesc, stack: pStack || undefined, repoUrl: pRepo || undefined }); setPName(""); setPDesc(""); setPStack(""); setPRepo(""); loadProjects(); loadDashboard(); return r; });
  }
  async function developFeature() {
    await run("project", async () => { const r = await postJson("/develop-feature", { projectId: selectedProject, feature }); loadFeaturePlans(); loadDashboard(); return r; });
  }
  async function decide(id: string, decision: "approved" | "rejected") {
    await run("approvals", async () => { const r = await postJson("/approval-decision", { approvalId: id, decision }); loadApprovals(); loadDashboard(); return r; });
  }

  function ResultView({ k }: { k: string }) {
    const data = output[k]; const isLoading = loading[k];
    if (isLoading) return <div className="result-box loading"><span className="spinner" /> {t.working}</div>;
    if (!data) return <div className="result-box empty">{t.resultEmpty}</div>;
    if (data.error) return <div className="result-box err"><strong>{t.errorWord}:</strong> {String(data.error)}</div>;
    const fields = ["answer", "plan", "critic", "codePlan", "review", "result"];
    const blocks = fields.filter((f) => typeof data[f] === "string");
    return (
      <div className="result-box">
        {data.approvalId ? <div className="badge-line">{t.approvalCreated}: <code>{String(data.approvalId)}</code></div> : null}
        {blocks.map((f) => (<div key={f} className="text-block"><h4>{t.resultLabels[f]}</h4><p>{String(data[f])}</p></div>))}
        {!blocks.length && <pre>{JSON.stringify(data, null, 2)}</pre>}
        {blocks.length ? <details className="raw"><summary>{t.showRaw}</summary><pre>{JSON.stringify(data, null, 2)}</pre></details> : null}
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
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
            <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>HEB</button>
          </div>
          <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="theme"><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
        </div>
        <form className="login-card" onSubmit={doLogin}>
          <img src="/ghost-logo.png" alt="GHOST" className="login-logo" />
          <h1>GHOST Agent Builder</h1>
          <p className="login-sub">{t.login.title}</p>
          <label>{t.login.username}</label>
          <input value={loginUser} onChange={(e) => setLoginUser(e.target.value)} placeholder="Alex" autoFocus autoComplete="username" />
          <label>{t.login.password}</label>
          <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="••••••" autoComplete="current-password" />
          {loginErr ? <div className="login-err">{loginErr}</div> : null}
          <button className="primary" type="submit" disabled={loginLoading || !loginUser.trim() || !loginPass}>{loginLoading ? t.login.signingIn : t.login.signIn}</button>
        </form>
      </div>
    );
  }

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
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
            <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>HEB</button>
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
              <span className="nav-ic"><Icon name={STEP_META[key].icon} /></span>
              <span className="nav-text">{t.steps[key].title}</span>
            </button>
          ))}
        </nav>

        <div className="mini-stats">
          <div><b>{counts.sources ?? "—"}</b><span>{t.miniSources}</span></div>
          <div><b>{counts.agent_skills ?? "—"}</b><span>{t.miniSkills}</span></div>
          <div><b>{counts.approvals ?? "—"}</b><span>{t.miniApprovals}</span></div>
        </div>

        <div className="user-row">
          <span className="user-ava">{auth.username.charAt(0).toUpperCase()}</span>
          <span className="user-name">{auth.username}</span>
          <button className="logout" onClick={logout} title={t.login.logout} aria-label={t.login.logout}><Icon name="logout" /></button>
        </div>
      </aside>

      <main className="content">
        <header className="page-head">
          <div>
            <p className="crumb">{t.step} {meta.n === "•" ? "—" : meta.n}</p>
            <h1>{t.steps[active].title}</h1>
            <p className="page-hint">{t.steps[active].hint}</p>
          </div>
          <button className="ghost" onClick={() => { loadDashboard(); loadSources(); loadSkills(); loadProjects(); loadFeaturePlans(); loadTasks(); loadApprovals(); }}>
            <Icon name="refresh" /> {t.refresh}
          </button>
        </header>

        {active === "overview" && (
          <section className="panel">
            <div className="stat-grid">
              {Object.keys(t.statLabels).map((k) => (
                <div key={k} className="stat-card"><b>{counts[k] ?? "—"}</b><span>{t.statLabels[k]}</span></div>
              ))}
            </div>
            <div className="text-block" style={{ marginTop: 18 }}>
              <h4>{t.recentTitle}</h4>
              {Array.isArray(stats?.recentLogs) && (stats!.recentLogs as Json[]).length ? (
                <ul className="log-list">
                  {(stats!.recentLogs as Json[]).map((l) => (<li key={String(l.id)}><span className="tag">{String(l.type)}</span> {String(l.message)}</li>))}
                </ul>
              ) : <p className="muted">{t.noEvents}</p>}
            </div>
          </section>
        )}

        {active === "learn" && (
          <section className="panel">
            <div className="explain">{t.learnExplain}</div>
            <div className="form-card">
              <label>{t.urlLabel}</label>
              <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://example.com/docs" onKeyDown={(e) => { if (e.key === "Enter") addSource(); }} />
              <div className="form-row">
                <div><label>{t.topicLabel}</label><input value={sourceTopic} onChange={(e) => setSourceTopic(e.target.value)} placeholder="platform" /></div>
                <div><label>{t.tagsLabel}</label><input value={sourceTags} onChange={(e) => setSourceTags(e.target.value)} placeholder="docs, api" /></div>
              </div>
              <button className="primary" onClick={addSource} disabled={loading.learn || !sourceUrl.trim()}><Icon name="plus" /> {loading.learn ? t.learning : t.addSource}</button>
            </div>
            <div className="list-head"><h3>{t.learnedSources} ({sources.length})</h3><button className="ghost sm" onClick={loadSources}><Icon name="refresh" /> {t.refreshList}</button></div>
            {sources.length ? (
              <ul className="source-list">
                {sources.map((s) => (
                  <li key={String(s.id)}>
                    <span className="src-ic"><Icon name="link" /></span>
                    <div className="src-main"><a href={String(s.url)} target="_blank" rel="noreferrer">{String(s.title || s.url)}</a><span className="src-url">{String(s.url)}</span></div>
                    <span className="src-chunks">{Number(s.chunks ?? 0)} {t.chunksUnit}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{t.noSources}</p>}
            <ResultView k="learn" />
          </section>
        )}

        {active === "skills" && (
          <section className="panel">
            <div className="explain">{t.skillsExplain}</div>
            <div className="form-card">
              <label>{t.skillTopic}</label>
              <input value={skillTopic} onChange={(e) => setSkillTopic(e.target.value)} placeholder="authentication, api design…" />
              <button className="primary" onClick={extractSkills} disabled={loading.skills}><Icon name="skills" /> {loading.skills ? t.extracting : t.extractSkills}</button>
            </div>
            <div className="list-head"><h3>{t.mySkills} ({skills.length})</h3><button className="ghost sm" onClick={loadSkills}><Icon name="refresh" /> {t.refreshList}</button></div>
            {skills.length ? (
              <ul className="skill-list">
                {skills.map((s) => (
                  <li key={String(s.id)}>
                    <div className="skill-head"><b>{String(s.skillName)}</b>{s.source === "learned" ? <span className="tag">learned</span> : null}</div>
                    <p>{String(s.description)}</p>
                    {s.example ? <code className="skill-ex">{t.exampleLabel}: {String(s.example)}</code> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{t.noSkills}</p>}
            <ResultView k="skills" />
          </section>
        )}

        {active === "project" && (
          <section className="panel">
            <div className="explain">{t.projectExplain}</div>
            <div className="form-card">
              <div className="form-row">
                <div><label>{t.nameLabel}</label><input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="My SaaS" /></div>
                <div><label>{t.stackLabel}</label><input value={pStack} onChange={(e) => setPStack(e.target.value)} placeholder="Next.js, Firebase" /></div>
              </div>
              <label>{t.descLabel}</label>
              <textarea value={pDesc} onChange={(e) => setPDesc(e.target.value)} placeholder="What the project does" />
              <label>{t.repoLabel}</label>
              <input value={pRepo} onChange={(e) => setPRepo(e.target.value)} placeholder="https://github.com/you/repo" />
              <button className="primary" onClick={createProject} disabled={loading.project || pName.trim().length < 2 || pDesc.trim().length < 5}><Icon name="plus" /> {t.createProject}</button>
            </div>

            <div className="form-card">
              <label>{t.selectProject}</label>
              <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
                <option value="">—</option>
                {projects.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>)}
              </select>
              <label>{t.featureLabel}</label>
              <textarea value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="Add Stripe subscription billing with webhooks" />
              <button className="primary alt" onClick={developFeature} disabled={loading.project || !selectedProject || feature.trim().length < 5}>
                <Icon name="generate" /> {loading.project ? t.developing : t.developFeature}
              </button>
            </div>

            {projects.length === 0 ? <p className="muted">{t.noProjects}</p> : null}
            {featurePlans.length ? (
              <>
                <div className="list-head"><h3>{t.featurePlansTitle} ({featurePlans.length})</h3></div>
                <ul className="task-list">
                  {featurePlans.map((f) => (
                    <li key={String(f.id)}>
                      <span className={`status status-${String(f.status)}`}>{String(f.status)}</span>
                      <div className="task-main"><b>{String(f.feature)}</b><span>{String(f.projectName || "")} · {Number(f.skillsUsed ?? 0)} {t.skillsUsedLabel}</span></div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <ResultView k="project" />
          </section>
        )}

        {active === "ask" && (
          <section className="panel">
            <div className="explain">{t.askExplain}</div>
            <div className="form-card">
              <label>{t.questionLabel}</label>
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What did we learn about authentication?" />
              <button className="primary" onClick={() => run("ask", () => postJson("/ask", { question }))} disabled={loading.ask || question.trim().length < 3}>{loading.ask ? t.thinking : t.ask}</button>
            </div>
            <ResultView k="ask" />
          </section>
        )}

        {active === "plan" && (
          <section className="panel">
            <div className="explain">{t.planExplain}</div>
            <div className="form-card">
              <label>{t.ideaLabel}</label>
              <textarea value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="An online learning platform with an AI tutor" />
              <button className="primary" onClick={() => run("plan", () => postJson("/plan-platform", { idea }))} disabled={loading.plan || idea.trim().length < 5}>{loading.plan ? t.planning : t.designPlan}</button>
            </div>
            <ResultView k="plan" />
          </section>
        )}

        {active === "generate" && (
          <section className="panel">
            <div className="explain">{t.genExplain}</div>
            <div className="form-card">
              <label>{t.taskFieldLabel}</label>
              <textarea value={codeTask} onChange={(e) => setCodeTask(e.target.value)} placeholder="Build a JWT auth module" />
              <button className="primary" onClick={() => run("generate", async () => { const r = await postJson("/generate-code", { task: codeTask, createApproval: true }); loadDashboard(); return r; })} disabled={loading.generate || codeTask.trim().length < 5}>{loading.generate ? t.generating : t.generate}</button>
            </div>
            <ResultView k="generate" />
          </section>
        )}

        {active === "tasks" && (
          <section className="panel">
            <div className="explain">{t.tasksExplain}</div>
            <div className="form-card">
              <label>{t.titleLabel}</label>
              <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Set up CI/CD" />
              <label>{t.descLabel}</label>
              <textarea value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} placeholder="What to do and why" />
              <label>{t.priorityLabel}</label>
              <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value)}>
                <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="critical">critical</option>
              </select>
              <button className="primary" onClick={() => run("tasks", async () => { const r = await postJson("/tasks", { title: taskTitle, description: taskDescription, priority: taskPriority }); setTaskTitle(""); setTaskDescription(""); loadTasks(); loadDashboard(); return r; })} disabled={loading.tasks || taskTitle.trim().length < 3 || taskDescription.trim().length < 5}><Icon name="plus" /> {t.createTask}</button>
            </div>
            <div className="list-head"><h3>{t.tasksList} ({tasks.length})</h3></div>
            {tasks.length ? (
              <ul className="task-list">
                {tasks.map((tk) => (
                  <li key={String(tk.id)}>
                    <span className={`status status-${String(tk.status)}`}>{String(tk.status)}</span>
                    <div className="task-main"><b>{String(tk.title)}</b><span>{String(tk.description)}</span></div>
                    <span className={`prio prio-${String(tk.priority)}`}>{String(tk.priority)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{t.noTasks}</p>}
            <ResultView k="tasks" />
          </section>
        )}

        {active === "approvals" && (
          <section className="panel">
            <div className="explain">{t.approvalsExplain}</div>
            <div className="list-head"><h3>{t.approvalsList} ({approvals.length})</h3><button className="ghost sm" onClick={loadApprovals}><Icon name="refresh" /> {t.refresh}</button></div>
            {approvals.length ? (
              <ul className="approval-list">
                {approvals.map((a) => (
                  <li key={String(a.id)}>
                    <div className="appr-head"><b>{String(a.actionType)}</b><span className={`status status-${String(a.status)}`}>{String(a.status)}</span><span className={`prio prio-${String(a.riskLevel)}`}>{String(a.riskLevel)}</span></div>
                    {typeof a.review === "string" ? <p className="appr-review">{String(a.review).slice(0, 320)}{String(a.review).length > 320 ? "…" : ""}</p> : null}
                    {a.status === "pending" ? (<div className="appr-actions"><button className="ok" onClick={() => decide(String(a.id), "approved")}>{t.approve}</button><button className="no" onClick={() => decide(String(a.id), "rejected")}>{t.reject}</button></div>) : null}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{t.noApprovals}</p>}
            <ResultView k="approvals" />
          </section>
        )}

        {active === "review" && (
          <section className="panel">
            <div className="explain">{t.reviewExplain}</div>
            <div className="form-card">
              <label>{t.contentLabel}</label>
              <textarea value={reviewContent} onChange={(e) => setReviewContent(e.target.value)} placeholder="Paste code or architecture" style={{ minHeight: 160 }} />
              <div className="form-row">
                <button className="primary" onClick={() => run("review", () => postJson("/review", { content: reviewContent, reviewType: "code" }))} disabled={loading.review || reviewContent.trim().length < 10}>{t.codeReview}</button>
                <button className="primary alt" onClick={() => run("review", () => postJson("/security-review", { content: reviewContent }))} disabled={loading.review || reviewContent.trim().length < 10}>{t.secReview}</button>
              </div>
            </div>
            <ResultView k="review" />
          </section>
        )}
      </main>
    </div>
  );
}
