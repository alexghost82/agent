import { db } from "./firebase";
import { tsMillis } from "./pure";
import { log } from "./log";

export interface ListOptions {
  collection: string;
  userId: string;
  // Additional equality filters (e.g. topicId, projectId).
  where?: [field: string, value: unknown][];
  orderField?: string;
  limit?: number;
}

export interface ListedDoc {
  id: string;
  [key: string]: unknown;
}

// Shared "scope to user → order → limit" reader. Relies on the composite
// indexes from contract §1 (userId == + <field> == + createdAt desc). If an
// index is not yet deployed, it degrades gracefully to an unordered fetch +
// in-memory sort so the endpoint keeps working during the index rollout.
export async function listScoped(opts: ListOptions): Promise<ListedDoc[]> {
  const orderField = opts.orderField ?? "createdAt";
  const limit = opts.limit ?? 200;
  let base: FirebaseFirestore.Query = db.collection(opts.collection).where("userId", "==", opts.userId);
  for (const [field, value] of opts.where ?? []) base = base.where(field, "==", value);

  try {
    const snap = await base.orderBy(orderField, "desc").limit(limit).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // FAILED_PRECONDITION = composite index missing. Fall back so the API stays
    // up while Architect's indexes propagate; log once so it is observable.
    const code = (err as { code?: number | string })?.code;
    if (code === 9 || code === "failed-precondition") {
      log("warn", "list_index_fallback", { collection: opts.collection, orderField });
      const snap = await base.limit(limit).get();
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => tsMillis((b as Record<string, unknown>)[orderField]) - tsMillis((a as Record<string, unknown>)[orderField]));
    }
    throw err;
  }
}
