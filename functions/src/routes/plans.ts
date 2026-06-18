import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { safeJsonObject } from "../pure";
import { llm } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { GeneratePlanSchema } from "../schemas";
import { normalizeLang, languageDirective } from "../lang";

export const plansRouter = Router();

interface PlanFile {
  path: string;
  content: string;
}
interface PlanPrompt {
  title?: string;
  content: string;
}

plansRouter.get("/generated-plans", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const plans = await listScoped({
      collection: "generated_plans",
      userId: req.userId!,
      where: projectId ? [["projectId", projectId]] : [],
      limit: 50
    });
    res.json({ plans });
  } catch (err) {
    sendError(req, res, err);
  }
});

plansRouter.post("/generate-plan", rateLimit("generate-plan", 12, 60_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, instructions, lang } = GeneratePlanSchema.parse(req.body);
    const replyLang = normalizeLang(lang);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const project = projDoc.data()!;

    // Selected skills.
    const skillDocs = await Promise.all(
      (project.skillIds || []).slice(0, 40).map((id: string) => db.collection("agent_skills").doc(id).get())
    );
    const skillsText = skillDocs
      .filter((d) => d.exists && d.data()?.userId === req.userId)
      .map((d) => `- ${d.data()?.skillName}: ${d.data()?.description}`)
      .join("\n") || "(no skills selected)";

    // Latest design decisions for the project (index-ordered, capped to 5).
    const decisionDocs = await listScoped({
      collection: "project_decisions",
      userId: req.userId!,
      where: [["projectId", projectId]],
      limit: 5
    });
    const decisions = decisionDocs
      .map((d) => `### ${(d as { section?: string }).section || "Общий дизайн"}\n${(d as { decision?: string }).decision || ""}`)
      .join("\n\n");

    let context = await searchMemory(
      `${project.name} ${project.description} ${instructions || ""}`,
      { userId: req.userId!, projectId },
      16
    );
    // Greenfield (from-scratch) projects have no project-scoped chunks; fall
    // back to the user's whole learned memory so plans build on studied topics.
    // Additive: only adds context when the scoped search returned nothing.
    if (!context.length) {
      context = await searchMemory(
        `${project.name} ${project.description} ${instructions || ""}`,
        { userId: req.userId! },
        16
      );
    }
    const contextText = context.map((c, i) => `[${i + 1}] ${c.title || c.sourcePath}: ${c.content}`).join("\n\n");

    const system =
      "Ты principal engineer и tech writer. На основе понимания проекта, навыков, знаний и решений по дизайну ты создаёшь: (1) нужное количество подробных markdown-файлов и (2) РОВНО ОДИН промпт-оркестратор. " +
      "Отвечай ТОЛЬКО валидным JSON без markdown-ограждений. Формат строго: " +
      '{"files":[{"path":"FILENAME.md","content":"<markdown>"}],"prompts":[{"title":"...","content":"..."}]}. ' +
      "Массив prompts ДОЛЖЕН содержать РОВНО ОДИН элемент — это единственный самодостаточный промпт-оркестратор для главного AI-агента. " +
      "При запуске этого промпта главный агент должен САМ: создать нужных под-агентов, выдать каждому точный под-промпт, скоординировать и проконтролировать их работу до полного завершения, и собрать результат. " +
      "Внутри этого единственного промпта обязательно укажи: полное ИМЯ ПРОЕКТА; всю ИДЕЮ/ОПИСАНИЕ проекта целиком и ключевые решения по дизайну; список ролей под-агентов с готовыми под-промптами для каждого; порядок и зависимости работ; правила контроля и критерии приёмки. " +
      "Промпт должен быть настолько полным и однозначным, чтобы агент НЕ задавал пользователю никаких уточняющих вопросов. " +
      "Каждый md-файл — содержательный и подробный. " +
      `${languageDirective(replyLang)} На этом языке пиши и содержимое md-файлов, и текст промпта (имена файлов и код оставляй как есть).`;

    const user = `ПРОЕКТ: ${project.name}
ОПИСАНИЕ: ${project.description}
СТЕК: ${project.stack || "не указан"}
GitHub репозиторий: ${project.repoUrl || "(не подключён)"}

РЕЗЮМЕ КОДА (read-only анализ):
${project.summary || "(нет)"}

НАВЫКИ АГЕНТА:
${skillsText}

РЕШЕНИЯ ПО ДИЗАЙНУ:
${decisions || "(нет)"}

ФРАГМЕНТЫ ПАМЯТИ/КОДА:
${contextText.slice(0, 16000)}

ДОП. ИНСТРУКЦИИ ПОЛЬЗОВАТЕЛЯ: ${instructions || "(нет)"}

Сгенерируй нужное количество md-файлов (например OVERVIEW.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, TASKS.md, TESTING.md) и РОВНО ОДИН промпт-оркестратор (массив prompts длиной ровно 1). В этот единственный промпт обязательно «зашей» имя проекта "${project.name}" и всю идею/описание проекта целиком, а также готовые под-промпты для под-агентов, чтобы исполнителю не требовалось задавать уточняющих вопросов. Все материалы — план/инструкции для проекта пользователя; ничего не применяется автоматически.`;

    const raw = await llm(system, user, 0.3, req.userId!);
    const parsed = safeJsonObject(raw);
    const files: PlanFile[] = Array.isArray(parsed?.files)
      ? parsed.files.filter((f: PlanFile) => f?.path && f?.content)
      : [];
    // Exactly one orchestrator prompt is expected; enforce it server-side in
    // case the model returns more than one.
    const prompts: PlanPrompt[] = (
      Array.isArray(parsed?.prompts) ? parsed.prompts.filter((p: PlanPrompt) => p?.content) : []
    ).slice(0, 1);

    if (!files.length && !prompts.length) {
      // Fallback: keep raw output so the user still gets something useful.
      files.push({ path: "PLAN.md", content: raw });
    }

    const ref = await db.collection("generated_plans").add({
      userId: req.userId,
      projectId,
      projectName: project.name,
      files,
      prompts,
      createdAt: serverTime()
    });
    await bumpCounter(req.userId!, "generated_plans");
    await logEvent(req.userId!, "plan_generated", project.name, { projectId, files: files.length, prompts: prompts.length });
    res.json({ id: ref.id, files, prompts });
  } catch (err) {
    sendError(req, res, err);
  }
});
