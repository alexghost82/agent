import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { safeJsonArray, scoreExtractedSkill } from "../pure";
import { llm } from "../ai";
import { gatherContext, type ScoredChunk } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound, badRequest } from "../errors";
import { ExtractSkillsSchema, SkillSchema } from "../schemas";

export interface ExtractedSkill {
  id: string;
  skillName: string;
  description: string;
  example: string | null;
  appliesTo: string[];
  quality: { score: number };
}

export const skillsRouter = Router();

// Raw skill candidate parsed from a batch LLM call (pre-validation).
export interface SkillCandidate {
  skillName: string;
  description: string;
  example: string | null;
  appliesTo: string[];
  template: string | null;
}

// How many context chunks each extraction batch feeds the model. Several
// batches let extract-skills traverse the WHOLE topic corpus instead of a
// single 16-fragment window (Epic 2.3). Read at CALL-TIME so it is env-tunable
// (`SKILL_EXTRACT_BATCH_CHUNKS`) without a rebuild; defaults to the historical
// value of 12, so behaviour is unchanged unless the env var is set.
function extractBatchChunks(): number {
  const n = Number(process.env.SKILL_EXTRACT_BATCH_CHUNKS);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

// Upper bound on batches so a huge corpus can't fan out into unbounded LLM cost.
// Env-tunable via `SKILL_EXTRACT_MAX_BATCHES` (default 8). The optional
// `SKILL_EXTRACT_FULL=1` "full pass" mode doubles the effective ceiling so large
// topics are covered more completely — cost stays bounded because we still cap.
function extractMaxBatches(): number {
  const n = Number(process.env.SKILL_EXTRACT_MAX_BATCHES);
  const base = Number.isFinite(n) && n > 0 ? n : 8;
  return process.env.SKILL_EXTRACT_FULL === "1" ? base * 2 : base;
}

// Parse + normalize one batch's raw LLM output into skill candidates.
export function parseSkillCandidates(raw: string): SkillCandidate[] {
  const out: SkillCandidate[] = [];
  for (const it of safeJsonArray(raw)) {
    if (!it?.skillName || !it?.description) continue;
    out.push({
      skillName: String(it.skillName),
      description: String(it.description),
      example: it.example ? String(it.example) : null,
      appliesTo: Array.isArray(it.appliesTo) ? it.appliesTo.map((x: unknown) => String(x)).slice(0, 50) : [],
      template: it.template ? String(it.template).slice(0, 8000) : null
    });
  }
  return out;
}

// Merge candidates across batches by skillName (case-insensitive), keeping the
// higher-quality variant and unioning the appliesTo tags (Epic 2.3).
export function mergeSkillCandidates(candidates: SkillCandidate[]): SkillCandidate[] {
  const byName = new Map<string, { cand: SkillCandidate; score: number }>();
  for (const c of candidates) {
    const key = c.skillName.trim().toLowerCase();
    if (!key) continue;
    const score = scoreExtractedSkill(c).score;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, { cand: { ...c }, score });
      continue;
    }
    const mergedApplies = Array.from(new Set([...prev.cand.appliesTo, ...c.appliesTo])).slice(0, 50);
    if (score > prev.score) {
      byName.set(key, { cand: { ...c, appliesTo: mergedApplies }, score });
    } else {
      prev.cand.appliesTo = mergedApplies;
    }
  }
  return [...byName.values()].map((v) => v.cand);
}

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

// Iterative skill extraction over the WHOLE topic corpus (Epic 2.3). Fans out
// across several angle subqueries, gathers a large summary-first context, then
// processes it batch by batch, accumulating + dedup-ing candidates before the
// quality gate. Reusable by both `/extract-skills` and the autonomous agent
// route (Epic 3) so the behaviour stays identical. Throws `badRequest` when the
// topic has no learned knowledge yet.
export async function extractSkillsForTopic(
  userId: string,
  topicId: string,
  topicName: string
): Promise<{ skills: ExtractedSkill[]; sourcesUsed: number }> {
  const subqueries = [
    `${topicName} key engineering practices, patterns and reusable skills`,
    `${topicName} architecture and design decisions`,
    `${topicName} implementation patterns and code conventions`,
    `${topicName} testing, security and reliability practices`,
    `${topicName} pitfalls, trade-offs and lessons learned`,
    topicName
  ].filter((s) => s.trim());
  const batchChunks = extractBatchChunks();
  const maxBatches = extractMaxBatches();
  const context = await gatherContext(
    subqueries,
    { userId, topicId },
    { perQuery: 16, maxChunks: batchChunks * maxBatches, charBudget: 120_000 }
  );
  if (!context.length) {
    throw badRequest("No knowledge in this topic yet. Add sources and learn them first.");
  }

  // Split the gathered corpus into batches and accumulate candidates across all
  // of them so extraction reflects everything learned, not a slice.
  const batches: ScoredChunk[][] = [];
  for (let i = 0; i < context.length; i += batchChunks) {
    batches.push(context.slice(i, i + batchChunks));
    if (batches.length >= maxBatches) break;
  }

  const rawCandidates: SkillCandidate[] = [];
  for (const batch of batches) {
    const contextText = batch.map((c, i) => `[${i + 1}] ${c.title}: ${c.content}`).join("\n\n");
    const raw = await llm(
      "You extract concrete, reusable engineering skills from studied material. Respond with ONLY a valid JSON array, no markdown.",
      `Topic: ${topicName}\n\nMaterial:\n${contextText}\n\nExtract 5-8 concrete reusable skills the agent now masters. ` +
        `For each skill include: skillName; description; example; appliesTo (array of stacks/tags it applies to, e.g. ["nextjs","firestore"]); ` +
        `template (a short reusable code/pattern snippet that can be applied during generation, or "" if not applicable). ` +
        `Format strictly: [{"skillName":"","description":"","example":"","appliesTo":[],"template":""}]`,
      0.2,
      userId
    );
    rawCandidates.push(...parseSkillCandidates(raw));
  }

  // Dedup/merge by skillName across batches, then quality-gate (CONTRACT v3.3).
  const merged = mergeSkillCandidates(rawCandidates);
  const minQuality = Number(process.env.SKILL_MIN_QUALITY) || 0.3;
  const saved: ExtractedSkill[] = [];
  for (const it of merged) {
    const quality = scoreExtractedSkill(it);
    // Drop low-value extractions (CONTRACT v3.3) so skills stay applicable.
    if (quality.score < minQuality) continue;
    const ref = await db.collection("agent_skills").add({
      userId,
      topicId,
      skillName: it.skillName,
      description: it.description,
      example: it.example,
      appliesTo: it.appliesTo,
      template: it.template,
      version: 2,
      quality,
      source: "learned",
      memoryType: "procedural",
      createdAt: serverTime()
    });
    saved.push({ id: ref.id, skillName: it.skillName, description: it.description, example: it.example, appliesTo: it.appliesTo, quality });
  }
  if (saved.length) await bumpCounter(userId, "agent_skills", saved.length);
  await logEvent(userId, "skills_extracted", `Extracted ${saved.length} skills`, { topicId, count: saved.length, batches: batches.length });
  return { skills: saved, sourcesUsed: context.length };
}

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
      const result = await extractSkillsForTopic(req.userId!, topicId, topicName);
      res.json(result);
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
