import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { tsMillis, safeJsonArray } from "../pure";
import { llm } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { ExtractSkillsSchema, SkillSchema } from "../schemas";

export const skillsRouter = Router();

skillsRouter.get("/skills", async (req: AuthedRequest, res: Response) => {
  try {
    const topicId = typeof req.query.topicId === "string" ? req.query.topicId : null;
    let q: FirebaseFirestore.Query = db.collection("agent_skills").where("userId", "==", req.userId);
    if (topicId) q = q.where("topicId", "==", topicId);
    const snap = await q.limit(200).get();
    const skills = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    res.json({ skills });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "skills_failed" });
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
    await logEvent(req.userId!, "skill_saved", body.skillName, { id: ref.id });
    res.json({ status: "skill_saved", id: ref.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "skill_failed" });
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
        res.status(404).json({ error: "Topic not found" });
        return;
      }
      const topicName = topicDoc.data()?.name || "";
      const context = await searchMemory(
        `${topicName} key engineering practices, patterns and reusable skills`,
        { userId: req.userId!, topicId },
        16
      );
      if (!context.length) {
        throw new Error("No knowledge in this topic yet. Add sources and learn them first.");
      }
      const contextText = context.map((c, i) => `[${i + 1}] ${c.title}: ${c.content}`).join("\n\n");
      const raw = await llm(
        "You extract concrete, reusable engineering skills from studied material. Respond with ONLY a valid JSON array, no markdown.",
        `Topic: ${topicName}\n\nMaterial:\n${contextText}\n\nExtract 5-8 concrete reusable skills the agent now masters. Format strictly: [{"skillName":"","description":"","example":""}]`
      );
      const items = safeJsonArray(raw);
      const saved: any[] = [];
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
        saved.push({ id: ref.id, skillName: it.skillName, description: it.description, example: it.example || null });
      }
      await logEvent(req.userId!, "skills_extracted", `Extracted ${saved.length} skills`, { topicId, count: saved.length });
      res.json({ skills: saved, sourcesUsed: context.length });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "extract_skills_failed" });
    }
  }
);
