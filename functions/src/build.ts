import { db } from "./firebase";
import { llm } from "./ai";
import { gatherContext } from "./memory";
import { safeJsonObject, normalizeBuildFiles, deriveSubqueries, type BuildFile } from "./pure";
import { normalizeLang, languageDirective, type ReplyLang } from "./lang";
import { verifyBuild, type Verification, type VerificationStatus } from "./sandbox";

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

// Auto-fix is ON by default (Epic 4.2) but safe: at most ONE extra LLM pass.
// Disable with BUILD_AUTOFIX=0/false.
export function buildAutofixEnabled(): boolean {
  const v = process.env.BUILD_AUTOFIX;
  return v === undefined || v === "1" || v === "true";
}

// Repair context handed back to the model on the auto-fix pass: the files it
// previously produced plus a compact digest of which checks failed and why.
export interface RepairContext {
  previousFiles: BuildFile[];
  failures: string;
}

export interface VerifiedBuildResult extends BuildResult {
  verification: Verification;
  // True when the auto-fix pass produced a strictly better verification and its
  // artifacts were kept over the first attempt.
  autofixed: boolean;
}

// Higher is better. Used to decide whether an auto-fix retry is an improvement.
function statusRank(status: VerificationStatus): number {
  switch (status) {
    case "passed": return 3;
    case "skipped": return 2;
    case "error": return 1;
    case "failed": return 0;
  }
}

// Compact, bounded digest of the failed checks (+ captured logs when present) so
// the repair prompt can tell the model exactly what to fix without blowing the
// context budget.
export function summarizeVerificationFailures(verification: Verification, maxChars = 4000): string {
  const lines: string[] = [];
  for (const c of verification.checks) {
    if (c.ok) continue;
    lines.push(`- ${c.name}: ${c.detail ? c.detail.slice(0, 600) : "failed"}`);
  }
  for (const l of verification.logs || []) {
    const out = [l.stdout, l.stderr].filter(Boolean).join("\n").trim();
    if (out) lines.push(`# ${l.name} (exit ${l.exitCode ?? "?"}):\n${out.slice(0, 800)}`);
  }
  return lines.join("\n").slice(0, maxChars) || "(no detailed failure logs)";
}

// Render the previous files as a compact path+content listing for the repair
// prompt, bounded so a large build can't blow the token budget.
function previousFilesText(files: BuildFile[], maxChars = 12000): string {
  return files
    .map((f) => `### ${f.path}\n${f.content}`)
    .join("\n\n")
    .slice(0, maxChars);
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
  // Present only on an auto-fix retry (Epic 4.2): previous files + failure logs.
  repair?: RepairContext;
}): Promise<BuildResult> {
  const { userId, projectId, project } = opts;
  const replyLang = normalizeLang(opts.lang);

  const skillsText = await selectedSkillsText(userId, project.skillIds || []);

  // Build several focused subqueries (project identity, instructions, task
  // breakdown) and gather a merged, summary-first, budgeted context across the
  // whole corpus instead of a single broad query (Epic 2.2).
  const subqueries = deriveSubqueries({
    name: project.name,
    description: project.description,
    instructions: opts.instructions
  });
  let context = await gatherContext(subqueries, { userId, projectId }, { maxChunks: 40, charBudget: 16000 });
  // Greenfield projects have no project-scoped chunks; fall back to the user's
  // whole learned memory so builds still draw on studied topics.
  if (!context.length) {
    context = await gatherContext(subqueries, { userId }, { maxChunks: 40, charBudget: 16000 });
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

  const repairBlock = opts.repair
    ? `

ПРЕДЫДУЩАЯ ГЕНЕРАЦИЯ НЕ ПРОШЛА ПРОВЕРКИ. Исправь перечисленные ошибки и верни ПОЛНЫЙ набор файлов (а не дифф).
ЛОГИ ПРОВАЛЕННЫХ ПРОВЕРОК:
${opts.repair.failures}

ПРЕДЫДУЩИЕ ФАЙЛЫ (исправь их):
${previousFilesText(opts.repair.previousFiles)}`
    : "";

  const raw = await llm(system, user + repairBlock, 0.3, userId);
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

// BUILD as verified development (Epic 4.2): generate → verify → (optional) ONE
// auto-fix pass that re-prompts the model with the failed-check logs, then keep
// whichever attempt verified better. Reusable by both the build route and the
// autonomous agent route so verification + repair behaviour stays identical.
export async function runVerifiedBuild(
  buildRunId: string,
  opts: Parameters<typeof runBuild>[0]
): Promise<VerifiedBuildResult> {
  const first = await runBuild(opts);
  const firstVerification = await verifyBuild(buildRunId, first.files);

  // Only attempt repair when verification actually failed and auto-fix is on.
  if (firstVerification.status !== "failed" || !buildAutofixEnabled()) {
    return { ...first, verification: firstVerification, autofixed: false };
  }

  const retry = await runBuild({
    ...opts,
    repair: { previousFiles: first.files, failures: summarizeVerificationFailures(firstVerification) }
  });
  const retryVerification = await verifyBuild(buildRunId, retry.files);

  // Keep the retry only if it verified strictly better (passed > … > failed).
  if (statusRank(retryVerification.status) > statusRank(firstVerification.status)) {
    return { ...retry, verification: retryVerification, autofixed: true };
  }
  return { ...first, verification: firstVerification, autofixed: false };
}
