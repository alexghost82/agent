import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { bumpCounter } from "./stats";

export function serverTime() {
  return FieldValue.serverTimestamp();
}

function logTtlMs(): number {
  const days = Number(process.env.AGENT_LOGS_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 90) * 24 * 60 * 60 * 1000;
}

export async function logEvent(
  userId: string | null,
  type: string,
  message: string,
  data: Record<string, unknown> = {}
) {
  await db.collection("agent_logs").add({
    userId: userId || null,
    type,
    message,
    data,
    createdAt: serverTime(),
    // TTL field: a Firestore TTL policy on `expireAt` reaps old logs (infra is
    // configured by the Architect/ops; the field is written here).
    expireAt: Timestamp.fromMillis(Date.now() + logTtlMs())
  });
  if (userId) await bumpCounter(userId, "agent_logs");
}
