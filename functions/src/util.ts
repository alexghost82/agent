import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase";

export function serverTime() {
  return FieldValue.serverTimestamp();
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
    createdAt: serverTime()
  });
}
