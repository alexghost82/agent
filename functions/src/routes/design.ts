import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { generateAnswer } from "../ai";
import { gatherContext } from "../memory";
import { deriveSubqueries } from "../pure";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { DesignSchema } from "../schemas";
import { normalizeLang, languageDirective } from "../lang";
import { recordOutcome } from "../learn";
import { recordUsage } from "../usage";

export const designRouter = Router();

// Cap the total number of skills folded into a design prompt (token/cost guard).
const MAX_DESIGN_SKILLS = 60;

// Build the "selected skills" prompt text from the project's saved skill ids and,
// optionally, every skill belonging to the selected skill categories (topicIds).
// Both sources are owner-scoped, de-duplicated by skill id and bounded.
async function selectedSkills(userId: string, skillIds: string[], topicIds: string[] = []): Promise<string> {
  const byId = new Map<string, { skillName: unknown; description: unknown }>();

  const idDocs = await Promise.all(
    skillIds.slice(0, MAX_DESIGN_SKILLS).map((id) => db.collection("agent_skills").doc(id).get())
  );
  for (const d of idDocs) {
    if (d.exists && d.data()?.userId === userId) {
      byId.set(d.id, { skillName: d.data()?.skillName, description: d.data()?.description });
    }
  }

  // Firestore `in` supports up to 10 values, so query one topic at a time.
  for (const topicId of topicIds.slice(0, 50)) {
    if (byId.size >= MAX_DESIGN_SKILLS) break;
    const snap = await db
      .collection("agent_skills")
      .where("userId", "==", userId)
      .where("topicId", "==", topicId)
      .limit(MAX_DESIGN_SKILLS)
      .get();
    for (const d of snap.docs) {
      if (byId.size >= MAX_DESIGN_SKILLS) break;
      if (!byId.has(d.id)) {
        byId.set(d.id, { skillName: d.data()?.skillName, description: d.data()?.description });
      }
    }
  }

  if (!byId.size) return "(no skills selected)";
  return Array.from(byId.values())
    .map((s) => `- ${s.skillName}: ${s.description}`)
    .join("\n");
}

designRouter.get("/design", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const decisions = await listScoped({
      collection: "project_decisions",
      userId: req.userId!,
      where: projectId ? [["projectId", projectId]] : [],
      limit: 50
    });
    res.json({ decisions });
  } catch (err) {
    sendError(req, res, err);
  }
});

designRouter.post("/design", rateLimit("design", 20, 60_000), distributedRateLimit("design", 100, 3_600_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, section, topicIds, lang } = DesignSchema.parse(req.body);
    const replyLang = normalizeLang(lang);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const project = projDoc.data()!;
    const skillsText = await selectedSkills(req.userId!, project.skillIds || [], topicIds || []);
    // A project without an ingested repo summary is treated as greenfield
    // (built from scratch from the description + learned knowledge + skills).
    const greenfield = !project.summary;
    const idea = section?.trim();
    const focus = idea
      ? `ИДЕЯ/НАПРАВЛЕНИЕ ОТ ПОЛЬЗОВАТЕЛЯ: "${idea}".`
      : greenfield
        ? "Пользователь не указал отдельную идею — спроектируй платформу на основе описания проекта."
        : "Сделай дизайн обновления проекта в целом.";
    const basis = greenfield
      ? "Проект создаётся с нуля. Основывайся на описании проекта, полученных знаниях (память) и выбранных навыках агента."
      : "На основе понимания существующего проекта (read-only), навыков и памяти.";

    // Project-scoped knowledge first; if there is none (typical for greenfield
    // projects), fall back to the user's whole learned memory so designs still
    // build on the topics/sources the agent studied. Additive: this only adds
    // context when the scoped search returned nothing.
    const subqueries = deriveSubqueries({
      name: project.name,
      description: project.description,
      section
    });
    let context = await gatherContext(subqueries, { userId: req.userId!, projectId }, { maxChunks: 40, charBudget: 16000 });
    if (!context.length) {
      context = await gatherContext(subqueries, { userId: req.userId! }, { maxChunks: 40, charBudget: 16000 });
    }
    const prompt = `ПРОЕКТ: ${project.name}
ОПИСАНИЕ: ${project.description}
СТЕК: ${project.stack || "не указан"}
РЕЗЮМЕ КОДА (из GitHub, только для чтения):
${project.summary || "(репозиторий не подключён — проект с нуля)"}

ВЫБРАННЫЕ НАВЫКИ АГЕНТА:
${skillsText}

ЗАДАЧА: ${focus}
${basis} Предложи дизайн: 1) цель и контекст, 2) затрагиваемые модули/файлы, 3) предлагаемая архитектура, 4) модель данных и API при необходимости, 5) UX/экраны при необходимости, 6) риски и совместимость, 7) критерии готовности. НИЧЕГО не применяй к репозиторию пользователя — это только дизайн.

${languageDirective(replyLang)}`;
    const design = await generateAnswer(prompt, context, req.userId!, replyLang);
    const ref = await db.collection("project_decisions").add({
      userId: req.userId,
      projectId,
      projectName: project.name,
      section: section || null,
      decision: design,
      createdAt: serverTime()
    });
    await bumpCounter(req.userId!, "project_decisions");
    await recordUsage(req.userId!, "design");
    // Self-learning (CONTRACT v3.4): feed the design outcome back into memory.
    await recordOutcome({
      userId: req.userId!,
      projectId,
      kind: "design_outcome",
      title: `Design: ${project.name}${section ? ` — ${section.slice(0, 80)}` : ""}`,
      content: design
    });
    await logEvent(req.userId!, "design_created", project.name, { projectId, section: section || null });
    res.json({ id: ref.id, plan: design, sources: context });
  } catch (err) {
    sendError(req, res, err);
  }
});
