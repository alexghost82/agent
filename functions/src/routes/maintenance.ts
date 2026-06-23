import { Router, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { logEvent } from "../util";
import { log } from "../log";
import { AuthedRequest } from "../auth";
import { sendError, badRequest } from "../errors";
import { COUNTED_COLLECTIONS } from "../stats";
import { SCAN_COLLECTIONS, purgeProjectIntel } from "../project-intelligence/storage/persist";

export const maintenanceRouter = Router();

// Max writes per batch. Kept under Firestore's hard 500-write-per-batch limit,
// matching the `deleteScopedByProject` paging pattern in routes/projects.ts.
const WIPE_BATCH = 400;

// Every per-user collection a full account wipe must clear. `flow_maps` is
// included even though it is not a counted collection. project-intelligence
// scan artifacts (project_scans/maps/nodes/edges/...) are NOT listed here: they
// are keyed by (userId, projectId) and removed via purgeProjectIntel for each
// of the user's projects as the `projects` collection is swept.
export const WIPE_COLLECTIONS = [
  "knowledge_chunks",
  "sources",
  "topics",
  "agent_skills",
  "projects",
  "project_decisions",
  "generated_plans",
  "flow_maps",
  "agent_logs"
] as const;

export type WipeCollection = (typeof WIPE_COLLECTIONS)[number];

type OwnedDoc = FirebaseFirestore.QueryDocumentSnapshot;

// Paged batched delete of every document in `collection` owned by `userId`.
// Pages in blocks of WIPE_BATCH so we never exceed Firestore's 500-write limit
// nor load an unbounded result set into memory. `onDoc` runs for each document
// BEFORE it is deleted (used to purge a project's intelligence artifacts).
async function deleteOwnedDocs(
  userId: string,
  collection: WipeCollection,
  onDoc?: (doc: OwnedDoc) => Promise<void>
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await db.collection(collection).where("userId", "==", userId).limit(WIPE_BATCH).get();
    if (snap.empty) break;
    if (onDoc) {
      for (const doc of snap.docs) await onDoc(doc);
    }
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < WIPE_BATCH) break;
  }
  return deleted;
}

// Reset every maintained stat counter to 0. Counters live in `user_stats/{uid}`
// (see stats.ts) — the same doc bumpCounter writes and readCounts reads — so we
// zero those fields directly instead of chasing per-collection deltas.
async function resetCounters(userId: string): Promise<void> {
  const zeroed: Record<string, number> = {};
  for (const c of COUNTED_COLLECTIONS) zeroed[c] = 0;
  await db
    .collection("user_stats")
    .doc(userId)
    .set({ ...zeroed, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export interface WipeResult {
  deleted: Record<string, number>;
}

// Core wipe shared by the HTTP route AND the standalone CLI: removes every
// per-user document across WIPE_COLLECTIONS, purges project-intelligence scan
// artifacts for each project, then resets the user's counters to 0. This is the
// pure data layer — it intentionally does NOT write an audit log; callers
// decide whether/how to record the action.
export async function wipeUserData(userId: string): Promise<WipeResult> {
  const deleted: Record<string, number> = {};
  let projectIntel = 0;

  for (const collection of WIPE_COLLECTIONS) {
    deleted[collection] = await deleteOwnedDocs(
      userId,
      collection,
      collection === "projects"
        ? async (doc) => {
            projectIntel += await purgeProjectIntel(userId, doc.id);
          }
        : undefined
    );
  }
  deleted.project_intel = projectIntel;

  await resetCounters(userId);
  return { deleted };
}

// Read-only count of what a wipe WOULD remove, per collection (+ project_intel).
// Used by the CLI's dry-run mode so an operator can preview the blast radius
// without writing anything. Uses count() aggregations to stay cheap.
export async function countUserData(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const c of WIPE_COLLECTIONS) {
    const snap = await db.collection(c).where("userId", "==", userId).count().get();
    counts[c] = snap.data().count;
  }

  let projectIntel = 0;
  // List only project ids (no field reads) so we can count their scan artifacts.
  const projects = await db.collection("projects").where("userId", "==", userId).select().get();
  for (const project of projects.docs) {
    for (const sc of SCAN_COLLECTIONS) {
      const snap = await db
        .collection(sc)
        .where("userId", "==", userId)
        .where("projectId", "==", project.id)
        .count()
        .get();
      projectIntel += snap.data().count;
    }
  }
  counts.project_intel = projectIntel;
  return counts;
}

// POST /me/wipe — irreversibly delete ALL of the caller's data. Guarded behind
// an explicit `{ confirm: true }` body so an accidental or empty POST can never
// nuke an account.
maintenanceRouter.post("/me/wipe", async (req: AuthedRequest, res: Response) => {
  try {
    if (req.body?.confirm !== true) {
      sendError(req, res, badRequest('confirmation required: send { "confirm": true } to wipe all your data'));
      return;
    }
    const userId = req.userId!;
    const { deleted } = await wipeUserData(userId);

    // Audit AFTER the sweep so the record survives the wipe: this re-creates a
    // single `agent_logs` doc (and bumps that counter back to 1) as an
    // intentional, truthful breadcrumb that the account was wiped. A structured
    // server log is also emitted for durable (Cloud Logging) audit.
    await logEvent(userId, "account_wiped", "user data fully wiped", { deleted });
    log("warn", "account_wiped", { userId, requestId: req.requestId, deleted });

    res.json({ status: "wiped", deleted });
  } catch (err) {
    sendError(req, res, err);
  }
});
