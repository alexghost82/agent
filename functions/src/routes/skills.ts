import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { safeJsonArray } from "../pure";
import { llm } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound, badRequest } from "../errors";
import { ExtractSkillsSchema, SkillSchema } from "../schemas";

export const skillsRouter = Router();

skillsRouter.get("/skills", async (req: AuthedRequest, res: Response) => {
  try {
    const topicId = typeof req.query.topicId === "string" ? req.query.topicId : null;
    const skills = await listScoped({
      collection: "agent_skills",
      userId: req.userId!,
      where: topicId ? [["topicId", topicId]] : []
    });
    res.json({ skills });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Manual skill creation.
skillsRouter.post("/skill", async (req: AuthedRequest, res: Response) => {
  try {
    const body = SkillSchema.parse(req.body);
    const ref = await db.collection("agent_skills").add({
      userId: req.userId,
      topicId: body.topicId,
      skillName: body.skillName,
      description: body.description,
      example: body.example || null,
      source: "manual",
      memoryType: "procedural",
      createdAt: serverTime()
    });
    await bumpCounter(req.userId!, "agent_skills");
    await logEvent(req.userId!, "skill_saved", body.skillName, { id: ref.id });
    res.json({ status: "skill_saved", id: ref.id });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Generate skills from everything the agent has learned within a topic.
skillsRouter.post(
  "/extract-skills",
  rateLimit("extract-skills", 20, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { topicId } = ExtractSkillsSchema.parse(req.body);
      const topicDoc = await db.collection("topics").doc(topicId).get();
      if (!topicDoc.exists || topicDoc.data()?.userId !== req.userId) {
        sendError(req, res, notFound());
        return;
      }
      const topicName = topicDoc.data()?.name || "";
      const context = await searchMemory(
        `${topicName} key engineering practices, patterns and reusable skills`,
        { userId: req.userId!, topicId },
        16
      );
      if (!context.length) {
        throw badRequest("No knowledge in this topic yet. Add sources and learn them first.");
      }
      const contextText = context.map((c, i) => `[${i + 1}] ${c.title}: ${c.content}`).join("\n\n");
      const raw = await llm(
        "You extract concrete, reusable engineering skills from studied material. Respond with ONLY a valid JSON array, no markdown.",
        `Topic: ${topicName}\n\nMaterial:\n${contextText}\n\nExtract 5-8 concrete reusable skills the agent now masters. Format strictly: [{"skillName":"","description":"","example":""}]`,
        0.2,
        req.userId!
      );
      const items = safeJsonArray(raw);
      const saved: { id: string; skillName: string; description: string; example: string | null }[] = [];
      for (const it of items.slice(0, 12)) {
        if (!it?.skillName || !it?.description) continue;
        const ref = await db.collection("agent_skills").add({
          userId: req.userId,
          topicId,
          skillName: String(it.skillName),
          description: String(it.description),
          example: it.example ? String(it.example) : null,
          source: "learned",
          memoryType: "procedural",
          createdAt: serverTime()
        });
        saved.push({ id: ref.id, skillName: String(it.skillName), description: String(it.description), example: it.example ? String(it.example) : null });
      }
      if (saved.length) await bumpCounter(req.userId!, "agent_skills", saved.length);
      await logEvent(req.userId!, "skills_extracted", `Extracted ${saved.length} skills`, { topicId, count: saved.length });
      res.json({ skills: saved, sourcesUsed: context.length });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
