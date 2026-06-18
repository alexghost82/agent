import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { generateAnswer } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { DesignSchema } from "../schemas";
import { normalizeLang, languageDirective } from "../lang";

export const designRouter = Router();

async function selectedSkills(userId: string, skillIds: string[]): Promise<string> {
  if (!skillIds.length) return "(no skills selected)";
  const docs = await Promise.all(skillIds.slice(0, 40).map((id) => db.collection("agent_skills").doc(id).get()));
  const lines = docs
    .filter((d) => d.exists && d.data()?.userId === userId)
    .map((d) => `- ${d.data()?.skillName}: ${d.data()?.description}`);
  return lines.length ? lines.join("\n") : "(no skills selected)";
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

designRouter.post("/design", rateLimit("design", 20, 60_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, section, lang } = DesignSchema.parse(req.body);
    const replyLang = normalizeLang(lang);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const project = projDoc.data()!;
    const skillsText = await selectedSkills(req.userId!, project.skillIds || []);
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
    let context = await searchMemory(
      `${project.name} ${project.description} ${section || ""}`,
      { userId: req.userId!, projectId },
      14
    );
    if (!context.length) {
      context = await searchMemory(
        `${project.name} ${project.description} ${section || ""}`,
        { userId: req.userId! },
        14
      );
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
    await logEvent(req.userId!, "design_created", project.name, { projectId, section: section || null });
    res.json({ id: ref.id, plan: design, sources: context });
  } catch (err) {
    sendError(req, res, err);
  }
});
