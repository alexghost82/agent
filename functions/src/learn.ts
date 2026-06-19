import { db } from "./firebase";
import { embedding } from "./ai";
import { serverTime } from "./util";
import { bumpCounter } from "./stats";
import { contentHash } from "./pure";
import { log } from "./log";

// Self-learning loop + dedup (CONTRACT v3.4 / v2.1).
//
// `recordOutcome` writes the result of a design/plan/build/ask back into memory
// as a new knowledge chunk so future generations can retrieve it. Dedup helpers
// keep re-learning the same material from duplicating chunks.

export type OutcomeKind = "design_outcome" | "plan_outcome" | "build_outcome" | "ask_outcome";

const OUTCOME_MIN_CHARS = 40;
const OUTCOME_MAX_CHARS = 12000;
const EMBED_INPUT_MAX = 8000;

// Collects the set of existing chunk contentHashes for a given source URL so a
// re-`/learn` of the same URL skips already-stored chunks. Equality-only query
// (userId + sourceUrl) → served by automatic single-field indexes.
export async function existingHashesForSource(userId: string, sourceUrl: string, cap = 5000): Promise<Set<string>> {
  const snap = await db
    .collection("knowledge_chunks")
    .where("userId", "==", userId)
    .where("sourceUrl", "==", sourceUrl)
    .limit(cap)
    .get();
  const set = new Set<string>();
  for (const d of snap.docs) {
    const h = d.data().contentHash;
    if (typeof h === "string") set.add(h);
  }
  return set;
}

// Best-effort: appends an outcome to memory. Never throws into the request path
// — a feedback-write failure must not fail the originating design/build/ask.
export async function recordOutcome(opts: {
  userId: string;
  projectId?: string | null;
  topicId?: string | null;
  kind: OutcomeKind;
  title: string;
  content: string;
}): Promise<{ saved: boolean }> {
  try {
    const content = (opts.content || "").trim();
    if (content.length < OUTCOME_MIN_CHARS) return { saved: false };
    const hash = contentHash(content);

    // Dedup: skip if this exact outcome content was already stored for the user.
    const dup = await db
      .collection("knowledge_chunks")
      .where("userId", "==", opts.userId)
      .where("contentHash", "==", hash)
      .limit(1)
      .get();
    if (!dup.empty) return { saved: false };

    const emb = await embedding(content.slice(0, EMBED_INPUT_MAX), opts.userId);
    await db.collection("knowledge_chunks").add({
      userId: opts.userId,
      scope: opts.projectId ? "project" : "build",
      projectId: opts.projectId || null,
      topicId: opts.topicId || null,
      title: opts.title.slice(0, 200),
      content: content.slice(0, OUTCOME_MAX_CHARS),
      embedding: emb,
      chunkType: opts.kind,
      confidence: 0.6,
      contentHash: hash,
      createdAt: serverTime()
    });
    await bumpCounter(opts.userId, "knowledge_chunks");
    return { saved: true };
  } catch (err) {
    log("warn", "record_outcome_failed", {
      userId: opts.userId,
      kind: opts.kind,
      message: err instanceof Error ? err.message : String(err)
    });
    return { saved: false };
  }
}
