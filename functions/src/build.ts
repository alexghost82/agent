import { db } from "./firebase";
import { llm } from "./ai";
import { searchMemory } from "./memory";
import { safeJsonObject, normalizeBuildFiles, type BuildFile } from "./pure";
import { normalizeLang, languageDirective, type ReplyLang } from "./lang";

// Upper bounds for a single build (CONTRACT v2.2). Generous but finite to guard
// storage/LLM cost and keep a build reviewable.
export function buildMaxFiles(): number {
  const n = Number(process.env.BUILD_MAX_FILES);
  return Number.isFinite(n) && n > 0 ? n : 40;
}
export function buildMaxFileBytes(): number {
  const n = Number(process.env.BUILD_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
}

export interface BuildProject {
  name: string;
  description: string;
  stack?: string | null;
  summary?: string | null;
  skillIds?: string[];
}

export interface BuildResult {
  files: BuildFile[];
  summary: string;
}

// Renders the selected skills (v2 fields used when present) into prompt text.
async function selectedSkillsText(userId: string, skillIds: string[]): Promise<string> {
  if (!skillIds.length) return "(no skills selected)";
  const docs = await Promise.all(
    skillIds.slice(0, 40).map((id) => db.collection("agent_skills").doc(id).get())
  );
  const lines = docs
    .filter((d) => d.exists && d.data()?.userId === userId)
    .map((d) => {
      const s = d.data()!;
      const applies = Array.isArray(s.appliesTo) && s.appliesTo.length ? ` [${s.appliesTo.join(", ")}]` : "";
      const tmpl = typeof s.template === "string" && s.template.trim() ? `\n  template: ${s.template}` : "";
      return `- ${s.skillName}${applies}: ${s.description}${tmpl}`;
    });
  return lines.length ? lines.join("\n") : "(no skills selected)";
}

// Renders an owned generated plan (files + the orchestrator prompt) as context.
function planText(plan: { files?: { path: string; content: string }[]; prompts?: { title?: string; content: string }[] } | null): string {
  if (!plan) return "(no plan selected)";
  const files = (plan.files || [])
    .map((f) => `### ${f.path}\n${f.content}`)
    .join("\n\n")
    .slice(0, 14000);
  const prompt = (plan.prompts || []).map((p) => p.content).join("\n\n").slice(0, 6000);
  return [files && `PLAN DOCS:\n${files}`, prompt && `ORCHESTRATOR PROMPT:\n${prompt}`]
    .filter(Boolean)
    .join("\n\n") || "(empty plan)";
}

// Core build step: assembles plan + skills + memory context and asks the model
// to emit real project files as strict JSON, then sanitizes them (CONTRACT v2.2).
// Pure data generation only — never touches GitHub or any external repo.
export async function runBuild(opts: {
  userId: string;
  projectId: string;
  project: BuildProject;
  plan: { files?: { path: string; content: string }[]; prompts?: { title?: string; content: string }[] } | null;
  instructions?: string;
  lang?: ReplyLang;
}): Promise<BuildResult> {
  const { userId, projectId, project } = opts;
  const replyLang = normalizeLang(opts.lang);

  const skillsText = await selectedSkillsText(userId, project.skillIds || []);

  let context = await searchMemory(
    `${project.name} ${project.description} ${opts.instructions || ""}`,
    { userId, projectId },
    16
  );
  if (!context.length) {
    context = await searchMemory(
      `${project.name} ${project.description} ${opts.instructions || ""}`,
      { userId },
      16
    );
  }
  const contextText = context
    .map((c, i) => `[${i + 1}] ${c.title || c.sourcePath}: ${c.content}`)
    .join("\n\n")
    .slice(0, 16000);

  const system =
    "Ты senior software engineer. Тебе дают проект, план, навыки и фрагменты знаний. " +
    "Сгенерируй РЕАЛЬНЫЕ файлы проекта (рабочий код, конфиги, тесты, документация) — не план, а готовые файлы. " +
    "Отвечай ТОЛЬКО валидным JSON без markdown-ограждений. Формат строго: " +
    '{"files":[{"path":"relative/path/file.ext","content":"<полное содержимое файла>"}],"summary":"<кратко что построено>"}. ' +
    "Пути относительные, без ведущего слэша и без '..'. Каждый файл — самодостаточный и согласован с остальными. " +
    `${languageDirective(replyLang)} На этом языке пиши summary, комментарии и тексты документации; имена файлов, код и идентификаторы оставляй как есть.`;

  const user = `ПРОЕКТ: ${project.name}
ОПИСАНИЕ: ${project.description}
СТЕК: ${project.stack || "не указан"}

РЕЗЮМЕ СУЩЕСТВУЮЩЕГО КОДА (read-only, если есть):
${project.summary || "(проект с нуля)"}

НАВЫКИ АГЕНТА:
${skillsText}

ПЛАН РАЗРАБОТКИ:
${planText(opts.plan)}

ФРАГМЕНТЫ ПАМЯТИ/ЗНАНИЙ:
${contextText || "(нет)"}

ДОП. ИНСТРУКЦИИ ПОЛЬЗОВАТЕЛЯ: ${opts.instructions || "(нет)"}

Сгенерируй реальные файлы проекта по плану и навыкам. Верни строго JSON по заданному формату.`;

  const raw = await llm(system, user, 0.3, userId);
  const parsed = safeJsonObject(raw);
  const files = normalizeBuildFiles(parsed?.files, buildMaxFiles(), buildMaxFileBytes());
  let summary = typeof parsed?.summary === "string" ? parsed.summary.slice(0, 4000) : "";

  if (!files.length) {
    // Fallback: keep raw output so the user still gets something reviewable,
    // rather than an empty build.
    const fallback = normalizeBuildFiles([{ path: "BUILD_OUTPUT.md", content: raw }], buildMaxFiles(), buildMaxFileBytes());
    if (!summary) summary = "Model returned no structured files; raw output preserved.";
    return { files: fallback, summary };
  }
  if (!summary) summary = `Generated ${files.length} file(s) for ${project.name}.`;
  return { files, summary };
}
