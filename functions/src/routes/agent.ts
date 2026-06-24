import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent, createProjectWithReadableId } from "../util";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { bumpCounter } from "../stats";
import { listScoped } from "../listing";
import { sendError, notFound } from "../errors";
import { AgentRunSchema } from "../schemas";
import { normalizeLang, languageDirective } from "../lang";
import { ingestUrl, recordOutcome } from "../learn";
import { extractSkillsForTopic } from "./skills";
import { gatherContext } from "../memory";
import { deriveSubqueries, safeJsonObject, selectSkillsForTask, type SelectableSkill } from "../pure";
import { generateAnswer, llm } from "../ai";
import { runVerifiedBuild } from "../build";
import { recordUsage } from "../usage";

// Autonomous agent (Epic 3): a single call orchestrates the WHOLE cycle —
// links + task → learn → extract skills → auto-pick skills → design → plan →
// verified build. Progress is streamed into `agent_runs` so the UI can poll it.
// It reuses the exact same building blocks as the individual routes (ingestUrl,
// extractSkillsForTopic, gatherContext, generateAnswer, runVerifiedBuild) so the
// security model (SSRF guard, read-only GitHub, sandboxed verification, encrypted
// keys) is unchanged. Heavy work is rate-limited like the other AI routes.
export const agentRouter = Router();

const ARTIFACT_WRITE_BATCH = 400;
const PLAN_SYSTEM =
  "Ты principal engineer и tech writer. На основе понимания проекта, навыков и знаний ты создаёшь: (1) нужное количество подробных markdown-файлов и (2) РОВНО ОДИН промпт-оркестратор. " +
  "Отвечай ТОЛЬКО валидным JSON без markdown-ограждений. Формат строго: " +
  '{"files":[{"path":"FILENAME.md","content":"<markdown>"}],"prompts":[{"title":"...","content":"..."}]}. ' +
  "Массив prompts ДОЛЖЕН содержать РОВНО ОДИН элемент — самодостаточный промпт-оркестратор для главного AI-агента.";

interface AgentStep {
  name: string;
  status: string;
  detail?: string;
}

// Owner-scoped fetch of a single agent run with its steps.
agentRouter.get("/agent/runs/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await db.collection("agent_runs").doc(String(req.params.id)).get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    res.json({ run: { id: doc.id, ...doc.data() } });
  } catch (err) {
    sendError(req, res, err);
  }
});

// List the caller's agent runs (owner-scoped, newest first).
agentRouter.get("/agent/runs", async (req: AuthedRequest, res: Response) => {
  try {
    const runs = await listScoped({ collection: "agent_runs", userId: req.userId!, limit: 50 });
    res.json({ runs });
  } catch (err) {
    sendError(req, res, err);
  }
});

agentRouter.post(
  "/agent/run",
  rateLimit("agent-run", 3, 60_000),
  distributedRateLimit("agent-run", 20, 3_600_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { urls, task, deep, lang } = AgentRunSchema.parse(req.body);
      const replyLang = normalizeLang(lang);
      const userId = req.userId!;
      const name = task.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 120) || "Agent run";
      const description = task.slice(0, 5000);

      const steps: AgentStep[] = [];
      const runRef = await db.collection("agent_runs").add({
        userId,
        task,
        urls,
        status: "learning",
        steps,
        topicId: null,
        projectId: null,
        buildRunId: null,
        errorCode: null,
        createdAt: serverTime(),
        updatedAt: serverTime()
      });
      const pushStep = async (status: string, step: AgentStep): Promise<void> => {
        steps.push(step);
        await runRef.update({ status, steps, updatedAt: serverTime() });
      };
      await logEvent(userId, "agent_run_started", name, { runId: runRef.id, urls: urls.length });

      try {
        // Topic + project for this run.
        const topicRef = await db.collection("topics").add({ userId, name, description, createdAt: serverTime() });
        await bumpCounter(userId, "topics");
        const projectId = await createProjectWithReadableId(
          {
            userId,
            name,
            description,
            stack: null,
            repoUrl: null,
            skillIds: [],
            summary: null,
            ingestStatus: "none",
            createdAt: serverTime()
          },
          name
        );
        const projectRef = db.collection("projects").doc(projectId);
        await bumpCounter(userId, "projects");

        // 1) LEARN — ingest every URL (a single bad URL never aborts the run).
        let learned = 0;
        let chunks = 0;
        for (const url of urls) {
          try {
            const r = await ingestUrl({ userId, topicId: topicRef.id, url, deep });
            learned += 1;
            chunks += r.chunks;
          } catch (e) {
            await logEvent(userId, "agent_ingest_failed", url, { runId: runRef.id, message: e instanceof Error ? e.message : String(e) });
          }
        }
        await recordUsage(userId, "ingest");
        await pushStep("skilling", { name: "learning", status: "done", detail: `${learned}/${urls.length} urls, ${chunks} chunks` });

        // 2) SKILLS — extract reusable skills from the whole topic corpus.
        let extracted: { id: string; skillName: string; description: string; appliesTo: string[] }[] = [];
        try {
          const r = await extractSkillsForTopic(userId, topicRef.id, name);
          extracted = r.skills;
        } catch (e) {
          await logEvent(userId, "agent_skills_skipped", name, { runId: runRef.id, message: e instanceof Error ? e.message : String(e) });
        }

        // 3) AUTO-PICK skills for the task (the project starts with none).
        const selectable: SelectableSkill[] = extracted.map((s) => ({
          id: s.id,
          skillName: s.skillName,
          description: s.description,
          appliesTo: s.appliesTo
        }));
        const skillIds = selectSkillsForTask(selectable, task).map((s) => s.id);
        if (skillIds.length) await projectRef.update({ skillIds, updatedAt: serverTime() });
        await pushStep("designing", { name: "skilling", status: "done", detail: `${extracted.length} skills, ${skillIds.length} selected` });

        // 4) DESIGN — ground a design decision in the learned memory.
        const subqueries = deriveSubqueries({ name, description: task });
        const context = await gatherContext(subqueries, { userId, topicId: topicRef.id }, { maxChunks: 40, charBudget: 16000 });
        const designPrompt = `ПРОЕКТ: ${name}
ЗАДАЧА: ${task}
Спроектируй: 1) цель и контекст, 2) затрагиваемые модули, 3) архитектура, 4) модель данных и API, 5) риски и критерии готовности. Это только дизайн — ничего не применяется.
${languageDirective(replyLang)}`;
        const design = await generateAnswer(designPrompt, context, userId, replyLang);
        await db.collection("project_decisions").add({
          userId,
          projectId: projectRef.id,
          projectName: name,
          section: null,
          decision: design,
          createdAt: serverTime()
        });
        await bumpCounter(userId, "project_decisions");
        await recordUsage(userId, "design");
        await pushStep("planning", { name: "designing", status: "done" });

        // 5) PLAN — md files + exactly one orchestrator prompt.
        const planUser = `ПРОЕКТ: ${name}
ОПИСАНИЕ: ${task}

РЕШЕНИЯ ПО ДИЗАЙНУ:
${design.slice(0, 8000)}

Сгенерируй нужное количество md-файлов и РОВНО ОДИН промпт-оркестратор (массив prompts длиной ровно 1). ${languageDirective(replyLang)}`;
        const planRaw = await llm(PLAN_SYSTEM, planUser, 0.3, userId);
        const planParsed = safeJsonObject(planRaw);
        const planFiles: { path: string; content: string }[] = Array.isArray(planParsed?.files)
          ? planParsed.files.filter((f: { path?: string; content?: string }) => f?.path && f?.content)
          : [];
        const planPrompts: { title?: string; content: string }[] = (
          Array.isArray(planParsed?.prompts) ? planParsed.prompts.filter((p: { content?: string }) => p?.content) : []
        ).slice(0, 1);
        if (!planFiles.length && !planPrompts.length) planFiles.push({ path: "PLAN.md", content: planRaw });
        const planRef = await db.collection("generated_plans").add({
          userId,
          projectId: projectRef.id,
          projectName: name,
          files: planFiles,
          prompts: planPrompts,
          createdAt: serverTime()
        });
        await bumpCounter(userId, "generated_plans");
        await recordUsage(userId, "plan");
        await pushStep("building", { name: "planning", status: "done", detail: `${planFiles.length} docs` });

        // 6) BUILD — verified development with the auto-picked skills.
        const buildRunRef = await db.collection("build_runs").add({
          userId,
          projectId: projectRef.id,
          projectName: name,
          planId: planRef.id,
          instructions: task,
          status: "running",
          fileCount: 0,
          summary: "",
          errorCode: null,
          createdAt: serverTime(),
          updatedAt: serverTime()
        });
        const build = await runVerifiedBuild(buildRunRef.id, {
          userId,
          projectId: projectRef.id,
          project: { name, description: task, stack: null, summary: null, skillIds },
          plan: { files: planFiles, prompts: planPrompts },
          instructions: task,
          lang
        });

        for (let i = 0; i < build.files.length; i += ARTIFACT_WRITE_BATCH) {
          const slice = build.files.slice(i, i + ARTIFACT_WRITE_BATCH);
          const batch = db.batch();
          slice.forEach((f) => {
            const ref = db.collection("build_artifacts").doc();
            batch.set(ref, {
              userId,
              buildRunId: buildRunRef.id,
              projectId: projectRef.id,
              path: f.path,
              content: f.content,
              language: f.language,
              bytes: f.bytes,
              createdAt: serverTime()
            });
          });
          await batch.commit();
        }
        await buildRunRef.update({
          status: "ready",
          fileCount: build.files.length,
          summary: build.summary,
          verification: build.verification,
          autofixed: build.autofixed,
          updatedAt: serverTime()
        });
        await recordOutcome({
          userId,
          projectId: projectRef.id,
          kind: "build_outcome",
          title: `Build: ${name}`,
          content: `${build.summary}\n\nFiles:\n${build.files.map((f) => `- ${f.path}`).join("\n")}`
        });
        await recordUsage(userId, "build");
        await pushStep("ready", { name: "building", status: "done", detail: build.verification.status });

        await runRef.update({
          status: "ready",
          topicId: topicRef.id,
          projectId: projectRef.id,
          buildRunId: buildRunRef.id,
          updatedAt: serverTime()
        });
        await logEvent(userId, "agent_run_completed", name, {
          runId: runRef.id,
          projectId: projectRef.id,
          buildRunId: buildRunRef.id,
          files: build.files.length,
          verification: build.verification.status
        });

        res.json({
          runId: runRef.id,
          topicId: topicRef.id,
          projectId: projectRef.id,
          buildRunId: buildRunRef.id,
          files: build.files,
          summary: build.summary,
          verification: build.verification,
          steps
        });
      } catch (innerErr) {
        const code = innerErr instanceof Error && innerErr.message === "no_api_key" ? "no_api_key" : "internal";
        await runRef.update({ status: "error", errorCode: code, updatedAt: serverTime() }).catch(() => undefined);
        throw innerErr;
      }
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
