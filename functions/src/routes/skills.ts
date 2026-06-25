import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { scoreExtractedSkill } from "../pure";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { ExtractSkillsSchema, SkillSchema, SkillUpdateSchema } from "../schemas";
import { assertAiKeyAvailable } from "../ai";
import { createAiJob, enqueueAiJob } from "../aiJobs";

// The skill-extraction core lives in `skillsCore.ts` (mirroring plan.ts /
// designCore.ts / buildJob.ts) so the async job runner can import it without a
// circular dependency on this route module. Re-exported here so existing
// importers (tests) keep working unchanged.
export {
  extractSkillsForTopic,
  parseSkillCandidates,
  mergeSkillCandidates
} from "../skillsCore";
export type { ExtractedSkill, SkillCandidate } from "../skillsCore";

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
      appliesTo: body.appliesTo || [],
      template: body.template || null,
      version: 2,
      quality: scoreExtractedSkill(body),
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
// Extraction fans out across several batched LLM calls over the whole topic
// corpus, which routinely exceeds Firebase Hosting's 60s rewrite timeout. So we
// only validate ownership + key here and ENQUEUE an async job (see aiJobs.ts),
// returning 202 with a jobId; the client polls GET /ai-jobs/:id for the result.
// This stops the spurious "server error" the caller used to see when the rewrite
// timed out even though the background work kept saving skills.
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
      await assertAiKeyAvailable(req.userId!);
      const jobId = await createAiJob({
        userId: req.userId!,
        kind: "skills",
        projectId: topicId,
        params: { topicId, topicName }
      });
      await enqueueAiJob(jobId);
      res.status(202).json({ jobId, status: "queued" });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);

// Update an owned skill (name / description / example / appliesTo / template).
// Quality is recomputed from the merged result so the stored score stays in sync
// with the edited content (CONTRACT v3.3 quality gate).
skillsRouter.patch("/skills/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const ref = db.collection("agent_skills").doc(id);
    const doc = await ref.get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const body = SkillUpdateSchema.parse(req.body);
    const current = doc.data() || {};
    const merged = {
      skillName: body.skillName ?? (current.skillName as string),
      description: body.description ?? (current.description as string),
      example: body.example !== undefined ? body.example : ((current.example as string | null) ?? null),
      appliesTo: body.appliesTo ?? ((current.appliesTo as string[]) ?? []),
      template: body.template !== undefined ? body.template : ((current.template as string | null) ?? null)
    };
    const update: Record<string, unknown> = {
      skillName: merged.skillName,
      description: merged.description,
      example: merged.example,
      appliesTo: merged.appliesTo,
      template: merged.template,
      quality: scoreExtractedSkill(merged),
      updatedAt: serverTime()
    };
    await ref.update(update);
    await logEvent(req.userId!, "skill_updated", String(merged.skillName || id), { id });
    res.json({ id, status: "updated", skill: { id, ...current, ...update } });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Delete an owned skill. The skill ids are also referenced by projects
// (`skillIds`), but a stale id there is harmless — design/plan resolve skills by
// id and simply skip any that no longer exist.
skillsRouter.delete("/skills/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const ref = db.collection("agent_skills").doc(id);
    const doc = await ref.get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    await ref.delete();
    await bumpCounter(req.userId!, "agent_skills", -1);
    await logEvent(req.userId!, "skill_deleted", String(doc.data()?.skillName || id), { id });
    res.json({ id, status: "deleted" });
  } catch (err) {
    sendError(req, res, err);
  }
});
