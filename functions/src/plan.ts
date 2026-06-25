import { db } from "./firebase";
import { serverTime, logEvent } from "./util";
import { safeJsonObject, deriveSubqueries } from "./pure";
import { llm } from "./ai";
import { gatherContext } from "./memory";
import { buildProjectMapContext } from "./projectMapContext";
import { bumpCounter } from "./stats";
import { listScoped } from "./listing";
import { notFound } from "./errors";
import { normalizeLang, languageDirective } from "./lang";
import { recordUsage } from "./usage";

// Core plan generation (the slow, LLM-bound work). Extracted from the route so
// it can run in a background Cloud Tasks worker (see aiJobs.ts): repeated plans
// of many detailed md files routinely exceed Firebase Hosting's 60s rewrite
// timeout, so the HTTP endpoint only enqueues and this runs out of band.

interface PlanFile {
  path: string;
  content: string;
}
interface PlanPrompt {
  title?: string;
  content: string;
}

export interface PlanCoreParams {
  userId: string;
  projectId: string;
  instructions?: string;
  lang?: string;
}

export interface PlanCoreResult {
  id: string;
  files: PlanFile[];
  prompts: PlanPrompt[];
}

export async function runPlanCore(p: PlanCoreParams): Promise<PlanCoreResult> {
  const { userId, projectId, instructions } = p;
  const replyLang = normalizeLang(p.lang);

  const projDoc = await db.collection("projects").doc(projectId).get();
  if (!projDoc.exists || projDoc.data()?.userId !== userId) throw notFound();
  const project = projDoc.data()!;

  const mapContext = await buildProjectMapContext(userId, projectId);

  // Selected skills.
  const skillDocs = await Promise.all(
    (project.skillIds || []).slice(0, 40).map((id: string) => db.collection("agent_skills").doc(id).get())
  );
  const skillsText =
    skillDocs
      .filter((d) => d.exists && d.data()?.userId === userId)
      .map((d) => `- ${d.data()?.skillName}: ${d.data()?.description}`)
      .join("\n") || "(no skills selected)";

  // Latest design decisions for the project (index-ordered, capped to 5).
  const decisionDocs = await listScoped({
    collection: "project_decisions",
    userId,
    where: [["projectId", projectId]],
    limit: 5
  });
  const decisions = decisionDocs
    .map((d) => `### ${(d as { section?: string }).section || "Общий дизайн"}\n${(d as { decision?: string }).decision || ""}`)
    .join("\n\n");

  const subqueries = deriveSubqueries({
    name: project.name,
    description: project.description,
    instructions
  });
  let context = await gatherContext(subqueries, { userId, projectId }, { maxChunks: 40, charBudget: 16000 });
  // Greenfield (from-scratch) projects have no project-scoped chunks; fall back
  // to the user's whole learned memory so plans build on studied topics.
  if (!context.length) {
    context = await gatherContext(subqueries, { userId }, { maxChunks: 40, charBudget: 16000 });
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

КАРТА ПРОЕКТА (из GitHub-скана, структура и связи):
${mapContext || "(карта не построена)"}

НАВЫКИ АГЕНТА:
${skillsText}

РЕШЕНИЯ ПО ДИЗАЙНУ:
${decisions || "(нет)"}

ФРАГМЕНТЫ ПАМЯТИ/КОДА:
${contextText.slice(0, 16000)}

ДОП. ИНСТРУКЦИИ ПОЛЬЗОВАТЕЛЯ: ${instructions || "(нет)"}

Сгенерируй нужное количество md-файлов (например OVERVIEW.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, TASKS.md, TESTING.md) и РОВНО ОДИН промпт-оркестратор (массив prompts длиной ровно 1). В этот единственный промпт обязательно «зашей» имя проекта "${project.name}" и всю идею/описание проекта целиком, а также готовые под-промпты для под-агентов, чтобы исполнителю не требовалось задавать уточняющих вопросов. Все материалы — план/инструкции для проекта пользователя; ничего не применяется автоматически.`;

  const raw = await llm(system, user, 0.3, userId);
  const parsed = safeJsonObject(raw);
  const files: PlanFile[] = Array.isArray(parsed?.files)
    ? parsed.files.filter((f: PlanFile) => f?.path && f?.content)
    : [];
  // Exactly one orchestrator prompt is expected; enforce it server-side in case
  // the model returns more than one.
  const prompts: PlanPrompt[] = (
    Array.isArray(parsed?.prompts) ? parsed.prompts.filter((p2: PlanPrompt) => p2?.content) : []
  ).slice(0, 1);

  if (!files.length && !prompts.length) {
    // Fallback: keep raw output so the user still gets something useful.
    files.push({ path: "PLAN.md", content: raw });
  }

  const ref = await db.collection("generated_plans").add({
    userId,
    projectId,
    projectName: project.name,
    files,
    prompts,
    createdAt: serverTime()
  });
  await bumpCounter(userId, "generated_plans");
  await recordUsage(userId, "plan");
  await logEvent(userId, "plan_generated", project.name, { projectId, files: files.length, prompts: prompts.length });
  return { id: ref.id, files, prompts };
}
