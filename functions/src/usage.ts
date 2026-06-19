import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase";
import { log } from "./log";

// Per-user usage accounting (CONTRACT v3.7). Advisory only — recorded for future
// tariffs/quotas, not enforced yet. Stored in monthly buckets per user.

export type UsageKind = "ask" | "design" | "plan" | "build" | "ingest";

// Pure, unit-testable monthly bucket id (UTC) e.g. "2026-06".
export function usageBucketId(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Best-effort: never throws into the request path.
export async function recordUsage(userId: string, kind: UsageKind, units = 1): Promise<void> {
  try {
    const bucket = usageBucketId();
    await db.collection("usage").doc(`${userId}_${bucket}`).set(
      {
        userId,
        bucket,
        [kind]: FieldValue.increment(units),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    log("warn", "record_usage_failed", { userId, kind, message: err instanceof Error ? err.message : String(err) });
  }
}
