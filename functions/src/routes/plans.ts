import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { tsMillis, safeJsonObject } from "../pure";
import { llm } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { GeneratePlanSchema } from "../schemas";

export const plansRouter = Router();

plansRouter.get("/generated-plans", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    let q: FirebaseFirestore.Query = db.collection("generated_plans").where("userId", "==", req.userId);
    if (projectId) q = q.where("projectId", "==", projectId);
    const snap = await q.limit(50).get();
    const plans = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    res.json({ plans });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "generated_plans_failed" });
  }
});

plansRouter.post("/generate-plan", rateLimit("generate-plan", 12, 60_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { projectId, instructions } = GeneratePlanSchema.parse(req.body);
    const projDoc = await db.collection("projects").doc(projectId).get();
    if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
      res.status(404).json({ error: "Project not found" });
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

    // Latest design decisions for the project.
    const decisionsSnap = await db
      .collection("project_decisions")
      .where("userId", "==", req.userId)
      .where("projectId", "==", projectId)
      .limit(20)
      .get();
    const decisions = decisionsSnap.docs
      .map((d) => d.data())
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt))
      .slice(0, 5)
      .map((d: any) => `### ${d.section || "Общий дизайн"}\n${d.decision}`)
      .join("\n\n");

    const context = await searchMemory(
      `${project.name} ${project.description} ${instructions || ""}`,
      { userId: req.userId!, projectId },
      16
    );
    const contextText = context.map((c, i) => `[${i + 1}] ${c.title || c.sourcePath}: ${c.content}`).join("\n\n");

    const system =
      "Ты principal engineer и tech writer. На основе понимания проекта, навыков, знаний и решений по дизайну ты создаёшь готовые к работе материалы: подробные markdown-файлы и точные промпты для AI-агентов-исполнителей. " +
      "Отвечай ТОЛЬКО валидным JSON без markdown-ограждений. Формат строго: " +
      '{"files":[{"path":"FILENAME.md","content":"<markdown>"}],"prompts":[{"title":"...","content":"..."}]}. ' +
      "Каждый файл — содержательный и подробный на русском. Промпты — на русском, самодостаточные, готовые к вставке агенту.";

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

Сгенерируй 3-6 md-файлов (например OVERVIEW.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, TASKS.md, TESTING.md) и 3-6 промптов для агентов-исполнителей. Все материалы — план/инструкции для проекта пользователя; ничего не применяется автоматически.`;

    const raw = await llm(system, user, 0.3);
    const parsed = safeJsonObject(raw);
    const files = Array.isArray(parsed?.files) ? parsed.files.filter((f: any) => f?.path && f?.content) : [];
    const prompts = Array.isArray(parsed?.prompts) ? parsed.prompts.filter((p: any) => p?.content) : [];

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
    await logEvent(req.userId!, "plan_generated", project.name, { projectId, files: files.length, prompts: prompts.length });
    res.json({ id: ref.id, files, prompts });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "generate_plan_failed" });
  }
});
