import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { tsMillis } from "../pure";
import { generateAnswer } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { DesignSchema } from "../schemas";

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
    let q: FirebaseFirestore.Query = db.collection("project_decisions").where("userId", "==", req.userId);
    if (projectId) q = q.where("projectId", "==", projectId);
    const snap = await q.limit(50).get();
    const decisions = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    res.json({ decisions });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "design_list_failed" });
  }
});

designRouter.post("/design", rateLimit("design", 20, 60_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, section } = DesignSchema.parse(req.body);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const project = projDoc.data()!;
    const skillsText = await selectedSkills(req.userId!, project.skillIds || []);
    const focus = section?.trim()
      ? `Сфокусируйся на разделе/модуле проекта: "${section.trim()}".`
      : "Сделай дизайн обновления проекта в целом.";
    const context = await searchMemory(
      `${project.name} ${project.description} ${section || ""}`,
      { userId: req.userId!, projectId },
      14
    );
    const prompt = `ПРОЕКТ: ${project.name}
ОПИСАНИЕ: ${project.description}
СТЕК: ${project.stack || "не указан"}
РЕЗЮМЕ КОДА (из GitHub, только для чтения):
${project.summary || "(репозиторий не подключён)"}

ВЫБРАННЫЕ НАВЫКИ АГЕНТА:
${skillsText}

ЗАДАЧА: ${focus}
На основе понимания существующего проекта (read-only), навыков и памяти предложи дизайн обновления: 1) цель и контекст, 2) затрагиваемые модули/файлы, 3) предлагаемая архитектура изменения, 4) модель данных и API при необходимости, 5) UX/экраны при необходимости, 6) риски и совместимость, 7) критерии готовности. НИЧЕГО не применяй к репозиторию пользователя — это только дизайн.`;
    const design = await generateAnswer(prompt, context);
    const ref = await db.collection("project_decisions").add({
      userId: req.userId,
      projectId,
      projectName: project.name,
      section: section || null,
      decision: design,
      createdAt: serverTime()
    });
    await logEvent(req.userId!, "design_created", project.name, { projectId, section: section || null });
    res.json({ id: ref.id, plan: design, sources: context });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "design_failed" });
  }
});
