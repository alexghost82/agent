import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import * as crypto from "crypto";
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import { z } from "zod";
import * as dotenv from "dotenv";

// AI Builder Agent PRO
// Modules: research memory, skills memory, decisions, backlog, approval flow,
// reviewer, security review, code generation, logs, GitHub PR draft generation.

dotenv.config();

admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "4mb" }));

// Firebase Hosting forwards the full path (e.g. /api/login) to the function,
// while the emulator/direct URL serves routes at root (/login). Strip a leading /api.
app.use((req, _res, next) => {
  if (req.url === "/api") req.url = "/";
  else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
  next();
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LearnSchema = z.object({
  url: z.string().url(),
  tags: z.array(z.string()).optional(),
  topic: z.string().optional()
});
const AskSchema = z.object({ question: z.string().min(3), limit: z.number().optional() });
const PlanSchema = z.object({ idea: z.string().min(5) });
const CodeSchema = z.object({ task: z.string().min(5), stack: z.string().optional(), createApproval: z.boolean().optional() });
const SkillSchema = z.object({ skillName: z.string().min(2), description: z.string().min(5), example: z.string().optional() });
const TaskSchema = z.object({ title: z.string().min(3), description: z.string().min(5), priority: z.enum(["low", "medium", "high", "critical"]).default("medium") });
const ApprovalSchema = z.object({ actionType: z.string().min(2), payload: z.any(), riskLevel: z.enum(["low", "medium", "high", "critical"]).default("medium") });
const ApprovalDecisionSchema = z.object({ approvalId: z.string().min(3), decision: z.enum(["approved", "rejected"]), comment: z.string().optional() });
const ReviewSchema = z.object({ content: z.string().min(10), reviewType: z.enum(["architecture", "code", "security", "product"]).default("code") });
const ExecuteTaskSchema = z.object({ taskId: z.string().min(3) });
const ExtractSkillsSchema = z.object({ topic: z.string().optional() });
const ProjectSchema = z.object({ name: z.string().min(2), description: z.string().min(5), stack: z.string().optional(), repoUrl: z.string().optional() });
const DevelopFeatureSchema = z.object({ projectId: z.string().min(3), feature: z.string().min(5) });
const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

const DEFAULT_USERS = [
  { username: "Alex", password: "ghost" },
  { username: "Omer", password: "ghost" }
];

function hashPassword(password: string, salt: string): string {
  return crypto.createHmac("sha256", salt).update(password).digest("hex");
}

async function ensureDefaultUsers() {
  for (const u of DEFAULT_USERS) {
    const ref = db.collection("users").doc(u.username.toLowerCase());
    const doc = await ref.get();
    if (!doc.exists) {
      const salt = crypto.randomBytes(16).toString("hex");
      await ref.set({ username: u.username, salt, passwordHash: hashPassword(u.password, salt), createdAt: serverTime() });
    }
  }
}

function safeJsonArray(raw: string): any[] {
  try {
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function serverTime() {
  return FieldValue.serverTimestamp();
}

async function logEvent(type: string, message: string, data: Record<string, unknown> = {}) {
  await db.collection("agent_logs").add({ type, message, data, createdAt: serverTime() });
}

function chunkText(text: string, maxChars = 2200): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += maxChars) chunks.push(clean.slice(i, i + maxChars));
  return chunks.filter(Boolean);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function embedding(input: string): Promise<number[]> {
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input });
  return res.data[0].embedding;
}

async function readUrl(url: string): Promise<{ title: string; text: string }> {
  const response = await fetch(url, { headers: { "User-Agent": "AI Builder Agent PRO/1.0" } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, svg").remove();
  const title = $("title").text().trim() || url;
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 160000);
  return { title, text };
}

async function searchMemory(query: string, limit = 8) {
  const qEmbedding = await embedding(query);
  const snap = await db.collection("knowledge_chunks").limit(800).get();
  const scored = snap.docs.map((doc) => {
    const data = doc.data();
    const emb = data.embedding as number[] | undefined;
    return { id: doc.id, sourceUrl: data.sourceUrl, title: data.title, content: data.content, chunkType: data.chunkType, confidence: data.confidence, score: emb ? cosineSimilarity(qEmbedding, emb) : 0 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function llm(system: string, user: string, temperature = 0.2) {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
    temperature,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  });
  return response.choices[0].message.content || "";
}

async function generateAnswer(question: string, context: any[]) {
  const contextText = context.map((item, i) => `SOURCE ${i + 1}: ${item.title}\nURL: ${item.sourceUrl}\nTYPE: ${item.chunkType || "fact"}\nTEXT: ${item.content}`).join("\n\n---\n\n");
  return llm(
    "Ты AI-агент-архитектор и senior software engineer. Отвечай на русском. Используй контекст. Если данных не хватает — честно скажи. Всегда добавляй риски и следующий шаг.",
    `CONTEXT:\n${contextText}\n\nREQUEST:\n${question}`
  );
}

async function criticBeforeAction(action: string, payload: unknown) {
  return llm(
    "Ты строгий reviewer. Перед действием найди риски, альтернативы, критерии готовности и нужен ли human approval. Ответ на русском.",
    `Действие: ${action}\nPayload:\n${JSON.stringify(payload, null, 2)}\n\nВерни: план, риски, approval_required, rollback_plan, checklist.`
  );
}

app.get("/health", (_req, res) => res.json({ ok: true, version: "pro-1.0" }));

app.post("/login", async (req, res) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);
    await ensureDefaultUsers();
    const ref = db.collection("users").doc(username.trim().toLowerCase());
    const doc = await ref.get();
    const data = doc.data();
    if (!doc.exists || !data || hashPassword(password, data.salt) !== data.passwordHash) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    await ref.update({ sessionToken: token, lastLoginAt: serverTime() });
    await logEvent("login", `${data.username} signed in`, { username: data.username });
    res.json({ ok: true, token, user: { username: data.username } });
  } catch (err: any) { res.status(400).json({ error: err.message || "login_failed" }); }
});

app.post("/learn", async (req, res) => {
  try {
    const { url, tags, topic } = LearnSchema.parse(req.body);
    await logEvent("research_started", `Started learning ${url}`, { url, tags, topic });
    const page = await readUrl(url);
    const sourceRef = await db.collection("sources").add({ url, title: page.title, topic: topic || null, tags: tags || [], createdAt: serverTime() });
    const chunks = chunkText(page.text);
    let saved = 0;
    for (let i = 0; i < chunks.length; i += 25) {
      const batch = db.batch();
      const part = chunks.slice(i, i + 25);
      const embeddings = await Promise.all(part.map((chunk) => embedding(chunk)));
      part.forEach((chunk, idx) => {
        const ref = db.collection("knowledge_chunks").doc();
        batch.set(ref, { sourceId: sourceRef.id, sourceUrl: url, title: page.title, content: chunk, embedding: embeddings[idx], chunkType: "fact", confidence: 0.75, tags: tags || [], topic: topic || null, createdAt: serverTime() });
      });
      await batch.commit(); saved += part.length;
    }
    await logEvent("research_completed", `Saved ${saved} chunks from ${url}`, { sourceId: sourceRef.id, saved });
    res.json({ status: "saved", title: page.title, url, chunks: saved, sourceId: sourceRef.id });
  } catch (err: any) { res.status(400).json({ error: err.message || "learn_failed" }); }
});

app.post("/ask", async (req, res) => {
  try {
    const { question, limit } = AskSchema.parse(req.body);
    const context = await searchMemory(question, limit || 8);
    const answer = await generateAnswer(question, context);
    await logEvent("ask", question, { sources: context.map((x) => x.id) });
    res.json({ question, answer, sources: context });
  } catch (err: any) { res.status(400).json({ error: err.message || "ask_failed" }); }
});

app.post("/skill", async (req, res) => {
  try {
    const body = SkillSchema.parse(req.body);
    const ref = await db.collection("agent_skills").add({ ...body, memoryType: "procedural", createdAt: serverTime() });
    await logEvent("skill_saved", body.skillName, { id: ref.id });
    res.json({ status: "skill_saved", id: ref.id });
  } catch (err: any) { res.status(400).json({ error: err.message || "skill_failed" }); }
});

app.post("/plan-platform", async (req, res) => {
  try {
    const { idea } = PlanSchema.parse(req.body);
    const context = await searchMemory(idea, 12);
    const prompt = `На основе памяти спроектируй платформу для идеи: ${idea}\n\nДай: цель, аудиторию, роли, модули, БД, API, frontend-экраны, security model, риски, MVP на 7 дней, MVP на 30 дней, backlog задач.`;
    const plan = await generateAnswer(prompt, context);
    const critic = await criticBeforeAction("plan-platform", { idea, plan });
    const ref = await db.collection("project_decisions").add({ idea, decision: plan, critic, reason: "Generated from memory + architect agent", createdAt: serverTime() });
    res.json({ id: ref.id, plan, critic, sources: context });
  } catch (err: any) { res.status(400).json({ error: err.message || "plan_failed" }); }
});

app.post("/generate-code", async (req, res) => {
  try {
    const { task, stack, createApproval } = CodeSchema.parse(req.body);
    const context = await searchMemory(task, 12);
    const prompt = `Сгенерируй код для задачи: ${task}\nСтек: ${stack || "Next.js, Firebase Functions, Firestore"}\n\nДай структуру файлов, полный код, команды запуска, тесты/проверки, риски, rollback. Нельзя менять production напрямую.`;
    const codePlan = await generateAnswer(prompt, context);
    const review = await criticBeforeAction("generate-code", { task, stack, codePlan });
    const codeRef = await db.collection("generated_code").add({ task, stack: stack || null, codePlan, review, status: "draft", createdAt: serverTime() });
    let approvalId: string | null = null;
    if (createApproval !== false) {
      const approvalRef = await db.collection("approvals").add({ actionType: "apply_generated_code", payload: { generatedCodeId: codeRef.id, task }, riskLevel: "high", status: "pending", review, createdAt: serverTime() });
      approvalId = approvalRef.id;
    }
    res.json({ id: codeRef.id, approvalId, codePlan, review, sources: context });
  } catch (err: any) { res.status(400).json({ error: err.message || "code_failed" }); }
});

app.post("/tasks", async (req, res) => {
  try {
    const body = TaskSchema.parse(req.body);
    const ref = await db.collection("build_tasks").add({ ...body, status: "todo", createdAt: serverTime(), updatedAt: serverTime() });
    await logEvent("task_created", body.title, { id: ref.id });
    res.json({ id: ref.id, status: "todo" });
  } catch (err: any) { res.status(400).json({ error: err.message || "task_create_failed" }); }
});

app.get("/tasks", async (_req, res) => {
  const snap = await db.collection("build_tasks").orderBy("createdAt", "desc").limit(50).get();
  res.json({ tasks: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

app.post("/execute-task", async (req, res) => {
  try {
    const { taskId } = ExecuteTaskSchema.parse(req.body);
    const ref = db.collection("build_tasks").doc(taskId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Task not found");
    const task = doc.data();
    await ref.update({ status: "in_progress", updatedAt: serverTime() });
    const context = await searchMemory(`${task?.title}\n${task?.description}`, 10);
    const result = await generateAnswer(`Выполни planning/research по задаче и подготовь безопасный план реализации:\n${JSON.stringify(task)}`, context);
    const review = await criticBeforeAction("execute-task", { task, result });
    await ref.update({ status: "review", result, review, updatedAt: serverTime() });
    const approvalRef = await db.collection("approvals").add({ actionType: "complete_task", payload: { taskId, result }, riskLevel: "medium", status: "pending", review, createdAt: serverTime() });
    res.json({ taskId, status: "review", approvalId: approvalRef.id, result, review });
  } catch (err: any) { res.status(400).json({ error: err.message || "execute_task_failed" }); }
});

app.post("/approvals", async (req, res) => {
  try {
    const body = ApprovalSchema.parse(req.body);
    const review = await criticBeforeAction(body.actionType, body.payload);
    const ref = await db.collection("approvals").add({ ...body, review, status: "pending", createdAt: serverTime() });
    res.json({ id: ref.id, status: "pending", review });
  } catch (err: any) { res.status(400).json({ error: err.message || "approval_create_failed" }); }
});

app.get("/approvals", async (_req, res) => {
  const snap = await db.collection("approvals").orderBy("createdAt", "desc").limit(50).get();
  res.json({ approvals: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

app.post("/approval-decision", async (req, res) => {
  try {
    const { approvalId, decision, comment } = ApprovalDecisionSchema.parse(req.body);
    const ref = db.collection("approvals").doc(approvalId);
    await ref.update({ status: decision, comment: comment || null, decidedAt: serverTime() });
    await logEvent("approval_decision", decision, { approvalId, comment });
    res.json({ approvalId, status: decision });
  } catch (err: any) { res.status(400).json({ error: err.message || "approval_decision_failed" }); }
});

app.post("/review", async (req, res) => {
  try {
    const { content, reviewType } = ReviewSchema.parse(req.body);
    const system = `Ты ${reviewType}-reviewer. Найди слабые места, риски, ошибки, улучшения. Ответ на русском, структурно.`;
    const review = await llm(system, content);
    const ref = await db.collection("reviews").add({ reviewType, content, review, createdAt: serverTime() });
    res.json({ id: ref.id, review });
  } catch (err: any) { res.status(400).json({ error: err.message || "review_failed" }); }
});

app.post("/security-review", async (req, res) => {
  try {
    const { content } = ReviewSchema.pick({ content: true }).parse(req.body);
    const review = await llm("Ты application security engineer. Проверь код/архитектуру: auth, secrets, permissions, data leaks, SSRF, prompt injection, unsafe actions, rollback. Ответ на русском.", content);
    const ref = await db.collection("security_reviews").add({ content, review, createdAt: serverTime() });
    res.json({ id: ref.id, review });
  } catch (err: any) { res.status(400).json({ error: err.message || "security_review_failed" }); }
});

app.get("/skills", async (_req, res) => {
  try {
    const snap = await db.collection("agent_skills").orderBy("createdAt", "desc").limit(100).get();
    res.json({ skills: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err: any) { res.status(400).json({ error: err.message || "skills_failed" }); }
});

app.post("/extract-skills", async (req, res) => {
  try {
    const { topic } = ExtractSkillsSchema.parse(req.body);
    const context = await searchMemory(topic || "key engineering practices, patterns and reusable skills", 16);
    if (!context.length) throw new Error("No knowledge yet. Learn some sources first.");
    const contextText = context.map((c, i) => `[${i + 1}] ${c.title}: ${c.content}`).join("\n\n");
    const raw = await llm(
      "You extract concrete, reusable engineering skills from studied material. Respond with ONLY a valid JSON array, no markdown.",
      `Material:\n${contextText}\n\nExtract 5-8 concrete reusable skills the agent now masters. Format strictly: [{"skillName":"","description":"","example":""}]`
    );
    const items = safeJsonArray(raw);
    const saved: any[] = [];
    for (const it of items.slice(0, 12)) {
      if (!it?.skillName || !it?.description) continue;
      const ref = await db.collection("agent_skills").add({
        skillName: String(it.skillName), description: String(it.description), example: it.example ? String(it.example) : null,
        memoryType: "procedural", source: "learned", topic: topic || null, createdAt: serverTime()
      });
      saved.push({ id: ref.id, skillName: it.skillName, description: it.description, example: it.example || null });
    }
    await logEvent("skills_extracted", `Extracted ${saved.length} skills`, { topic, count: saved.length });
    res.json({ skills: saved, sourcesUsed: context.length });
  } catch (err: any) { res.status(400).json({ error: err.message || "extract_skills_failed" }); }
});

app.get("/projects", async (_req, res) => {
  try {
    const snap = await db.collection("projects").orderBy("createdAt", "desc").limit(100).get();
    res.json({ projects: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err: any) { res.status(400).json({ error: err.message || "projects_failed" }); }
});

app.post("/projects", async (req, res) => {
  try {
    const body = ProjectSchema.parse(req.body);
    const ref = await db.collection("projects").add({ ...body, stack: body.stack || null, repoUrl: body.repoUrl || null, createdAt: serverTime() });
    await logEvent("project_created", body.name, { id: ref.id });
    res.json({ id: ref.id, status: "created" });
  } catch (err: any) { res.status(400).json({ error: err.message || "project_create_failed" }); }
});

app.post("/develop-feature", async (req, res) => {
  try {
    const { projectId, feature } = DevelopFeatureSchema.parse(req.body);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists) throw new Error("Project not found");
    const project = projDoc.data();
    const skillsSnap = await db.collection("agent_skills").orderBy("createdAt", "desc").limit(40).get();
    const skills = skillsSnap.docs.map((d) => d.data());
    const skillsText = skills.length
      ? skills.map((s) => `- ${s.skillName}: ${s.description}`).join("\n")
      : "(no extracted skills yet)";
    const context = await searchMemory(`${project?.name} ${project?.description} ${feature}`, 14);
    const prompt = `PROJECT: ${project?.name}\nDESCRIPTION: ${project?.description}\nSTACK: ${project?.stack || "not specified"}\n\nREQUESTED FEATURE: ${feature}\n\nAGENT SKILLS (use them):\n${skillsText}\n\nUsing the skills and memory, produce an implementation plan with: 1) short solution summary, 2) affected files/modules, 3) step-by-step implementation plan, 4) code skeleton for key parts, 5) tests/verification, 6) risks, 7) definition of done. Do not apply anything to production.`;
    const plan = await generateAnswer(prompt, context);
    const critic = await criticBeforeAction("develop-feature", { projectId, feature });
    const ref = await db.collection("feature_plans").add({ projectId, projectName: project?.name || null, feature, plan, critic, skillsUsed: skills.length, status: "draft", createdAt: serverTime() });
    const approvalRef = await db.collection("approvals").add({ actionType: "implement_feature", payload: { projectId, feature, featurePlanId: ref.id }, riskLevel: "high", status: "pending", review: critic, createdAt: serverTime() });
    await logEvent("feature_planned", feature, { projectId, featurePlanId: ref.id });
    res.json({ id: ref.id, plan, critic, approvalId: approvalRef.id, skillsUsed: skills.length, sources: context });
  } catch (err: any) { res.status(400).json({ error: err.message || "develop_feature_failed" }); }
});

app.get("/feature-plans", async (req, res) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    let q = db.collection("feature_plans").orderBy("createdAt", "desc").limit(50) as FirebaseFirestore.Query;
    if (projectId) q = db.collection("feature_plans").where("projectId", "==", projectId).limit(50);
    const snap = await q.get();
    res.json({ featurePlans: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err: any) { res.status(400).json({ error: err.message || "feature_plans_failed" }); }
});

app.get("/sources", async (_req, res) => {
  try {
    const snap = await db.collection("sources").orderBy("createdAt", "desc").limit(100).get();
    const chunkSnaps = await Promise.all(
      snap.docs.map((d) => db.collection("knowledge_chunks").where("sourceId", "==", d.id).count().get())
    );
    const sources = snap.docs.map((d, i) => ({ id: d.id, ...d.data(), chunks: chunkSnaps[i].data().count }));
    res.json({ sources });
  } catch (err: any) { res.status(400).json({ error: err.message || "sources_failed" }); }
});

app.get("/dashboard", async (_req, res) => {
  const collections = ["users", "sources", "knowledge_chunks", "agent_skills", "projects", "feature_plans", "project_decisions", "build_tasks", "approvals", "generated_code", "agent_logs"];
  const counts: Record<string, number> = {};
  await Promise.all(collections.map(async (name) => { const snap = await db.collection(name).count().get(); counts[name] = snap.data().count; }));
  const logs = await db.collection("agent_logs").orderBy("createdAt", "desc").limit(10).get();
  res.json({ counts, recentLogs: logs.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

export const api = functions.https.onRequest(app);
