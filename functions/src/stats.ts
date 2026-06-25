import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase";
import { log } from "./log";

// Per-user maintained counters so the dashboard reads ONE document instead of
// running 8 count() aggregations on every load. Counters are incremented at the
// write sites; if the doc is missing it is lazily seeded from a one-time count()
// so pre-existing data is reflected accurately.

export const COUNTED_COLLECTIONS = [
  "topics",
  "sources",
  "knowledge_chunks",
  "agent_skills",
  "projects",
  "project_decisions",
  "generated_plans",
  "build_runs",
  "agent_logs"
] as const;

export type CountedCollection = (typeof COUNTED_COLLECTIONS)[number];

function statsRef(userId: string) {
  return db.collection("user_stats").doc(userId);
}

// Fire-and-forget friendly: callers may await or not. Never throws into the
// request path — a counter drift must not fail a successful mutation.
export async function bumpCounter(userId: string, field: CountedCollection, delta = 1): Promise<void> {
  try {
    await statsRef(userId).set({ [field]: FieldValue.increment(delta), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (err) {
    log("warn", "counter_bump_failed", { userId, field, delta, message: err instanceof Error ? err.message : String(err) });
  }
}

async function seedFromCounts(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await Promise.all(
    COUNTED_COLLECTIONS.map(async (name) => {
      const snap = await db.collection(name).where("userId", "==", userId).count().get();
      counts[name] = snap.data().count;
    })
  );
  await statsRef(userId).set({ ...counts, seededAt: FieldValue.serverTimestamp() }, { merge: true });
  return counts;
}

export async function readCounts(userId: string): Promise<Record<string, number>> {
  const doc = await statsRef(userId).get();
  if (!doc.exists) return seedFromCounts(userId);
  const data = doc.data() || {};
  const counts: Record<string, number> = {};
  for (const name of COUNTED_COLLECTIONS) counts[name] = typeof data[name] === "number" ? data[name] : 0;
  return counts;
}
