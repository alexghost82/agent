import { Router, Response } from "express";
import * as crypto from "crypto";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { encryptSecret } from "../crypto";
import { listScoped } from "../listing";
import { bumpCounter, CountedCollection } from "../stats";
import { sendError, notFound, badRequest } from "../errors";
import { enqueueIngest } from "../tasks";
import { enqueueScan, runScanJob } from "../projectScan";
import { log } from "../log";
import {
  createScan,
  readLatestScan,
  readMapPayload,
  readNodeDetail,
  purgeProjectIntel
} from "../project-intelligence/storage/persist";
import { ProjectSchema, UpdateProjectSchema, ConnectGithubSchema, GithubTokenSchema, FlowMapSchema, ScanRequestSchema } from "../schemas";

export const projectsRouter = Router();

async function ownedProject(userId: string, projectId: string) {
  const doc = await db.collection("projects").doc(projectId).get();
  if (!doc.exists || doc.data()?.userId !== userId) return null;
  return doc;
}

projectsRouter.get("/projects", async (req: AuthedRequest, res: Response) => {
  try {
    const projects = await listScoped({ collection: "projects", userId: req.userId! });
    res.json({ projects });
  } catch (err) {
    sendError(req, res, err);
  }
});

projectsRouter.post("/projects", async (req: AuthedRequest, res: Response) => {
  try {
    const body = ProjectSchema.parse(req.body);
    const ref = await db.collection("projects").add({
      userId: req.userId,
      name: body.name,
      description: body.description,
      stack: body.stack || null,
      repoUrl: body.repoUrl || null,
      skillIds: [],
      summary: null,
      ingestStatus: "none",
      createdAt: serverTime()
    });
    await bumpCounter(req.userId!, "projects");
    await logEvent(req.userId!, "project_created", body.name, { id: ref.id });
    res.json({ id: ref.id, status: "created" });
  } catch (err) {
    sendError(req, res, err);
  }
});

projectsRouter.patch("/projects/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await ownedProject(req.userId!, String(req.params.id));
    if (!doc) {
      sendError(req, res, notFound());
      return;
    }
    const body = UpdateProjectSchema.parse(req.body);
    const update: Record<string, unknown> = { updatedAt: serverTime() };
    if (body.skillIds) update.skillIds = body.skillIds;
    if (body.name) update.name = body.name;
    if (body.description) update.description = body.description;
    if (body.stack !== undefined) update.stack = body.stack || null;
    if (body.repoUrl !== undefined) update.repoUrl = body.repoUrl || null;
    await doc.ref.update(update);
    res.json({ id: doc.id, status: "updated" });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Delete everything in `collection` scoped to one project, paging in batches so
// we stay under Firestore's 500-write limit and never load an unbounded set into
// memory. Returns how many docs were removed so the caller can fix counters.
async function deleteScopedByProject(
  userId: string,
  projectId: string,
  collection: CountedCollection
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await db
      .collection(collection)
      .where("userId", "==", userId)
      .where("projectId", "==", projectId)
      .limit(400)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 400) break;
  }
  return deleted;
}

projectsRouter.delete("/projects/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await ownedProject(req.userId!, String(req.params.id));
    if (!doc) {
      sendError(req, res, notFound());
      return;
    }
    const userId = req.userId!;
    const projectId = doc.id;
    const name = (doc.data()?.name as string) || projectId;

    // Remove all data scoped to this project before the project doc itself, so a
    // deleted project leaves no orphaned knowledge, decisions or plans behind.
    const chunks = await deleteScopedByProject(userId, projectId, "knowledge_chunks");
    const decisions = await deleteScopedByProject(userId, projectId, "project_decisions");
    const plans = await deleteScopedByProject(userId, projectId, "generated_plans");
    // Project-intelligence scan artifacts (scans/maps/nodes/edges/...).
    const intel = await purgeProjectIntel(userId, projectId);

    await doc.ref.delete();

    await bumpCounter(userId, "projects", -1);
    if (chunks) await bumpCounter(userId, "knowledge_chunks", -chunks);
    if (decisions) await bumpCounter(userId, "project_decisions", -decisions);
    if (plans) await bumpCounter(userId, "generated_plans", -plans);

    await logEvent(userId, "project_deleted", name, { id: projectId, chunks, decisions, plans, intel });
    res.json({ id: projectId, status: "deleted" });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Store a per-user GitHub token, encrypted at rest. Never returned to the client.
projectsRouter.post("/github-token", async (req: AuthedRequest, res: Response) => {
  try {
    const { token } = GithubTokenSchema.parse(req.body);
    await db.collection("users").doc(req.userId!).update({ githubToken: encryptSecret(token) });
    res.json({ status: "saved" });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Read-only ingestion: indexes the repository into memory. Never writes to
// GitHub. The heavy work is offloaded to a Cloud Tasks worker (ADR-0002): this
// endpoint validates ownership, marks the project `queued`, enqueues the job and
// returns immediately (202). Progress + final state land on `projects/{id}`.
projectsRouter.post(
  "/projects/:id/connect-github",
  rateLimit("connect-github", 6, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const doc = await ownedProject(req.userId!, String(req.params.id));
      if (!doc) {
        sendError(req, res, notFound());
        return;
      }
      const { repoUrl } = ConnectGithubSchema.parse(req.body);
      // Per-request nonce: makes re-submission idempotent and lets a stale/retried
      // task detect it has been superseded by a newer request.
      const ingestToken = crypto.randomBytes(12).toString("hex");
      await doc.ref.update({
        repoUrl,
        ingestStatus: "queued",
        ingestError: null,
        ingestedFiles: 0,
        ingestToken,
        ingestQueuedAt: serverTime(),
        updatedAt: serverTime()
      });
      await enqueueIngest({ userId: req.userId!, projectId: doc.id, repoUrl, ingestToken });
      await logEvent(req.userId!, "github_ingest_queued", repoUrl, { projectId: doc.id });
      res.status(202).json({ status: "queued", projectId: doc.id });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);

// Project Intelligence scan (read-only). Like connect-github, this only
// ENQUEUES: it validates ownership, requires a connected repo, creates a scan
// document (pending), bumps the project's scanToken (supersession) and returns
// 202. The heavy analysis runs out-of-band in the scanWorker (Cloud Tasks).
async function startScanHandler(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const doc = await ownedProject(req.userId!, String(req.params.id));
    if (!doc) {
      sendError(req, res, notFound());
      return;
    }
    const repoUrl = String(doc.data()?.repoUrl || "");
    if (!repoUrl) {
      sendError(req, res, badRequest("project has no connected repository to scan"));
      return;
    }
    const body = ScanRequestSchema.parse(req.body ?? {});
    const options = { maxDepth: body.depth, ai: body.ai ?? false };
    const scanToken = crypto.randomBytes(12).toString("hex");
    const scanId = await createScan(req.userId!, doc.id, scanToken, options);
    await doc.ref.update({
      scanStatus: "queued",
      scanToken,
      scanError: null,
      mapStatus: "queued",
      mapError: null,
      lastScanRequestedAt: serverTime(),
      updatedAt: serverTime()
    });
    const payload = { userId: req.userId!, projectId: doc.id, scanId, repoUrl, scanToken, options };
    await logEvent(req.userId!, "project_scan_queued", repoUrl, { projectId: doc.id, scanId });

    if (scanRunsSync()) {
      // Deployed environments may lack the Cloud Tasks OIDC invoker binding on
      // the scanWorker Run service, so run the (bounded) scan inline within this
      // request instead of dispatching a task that would be rejected. runScanJob
      // records its own success/failure on the scan + project docs.
      try {
        await runScanJob(payload);
      } catch (err) {
        log("error", "scan_sync_failed", {
          projectId: doc.id,
          scanId,
          message: err instanceof Error ? err.message : String(err)
        });
      }
      const fresh = (await doc.ref.get()).data() || {};
      const mapStatus = String(fresh.mapStatus || "error");
      res.status(200).json({
        status: mapStatus,
        scanId,
        projectId: doc.id,
        nodeCount: Number(fresh.mapNodeCount ?? 0),
        edgeCount: Number(fresh.mapEdgeCount ?? 0)
      });
      return;
    }

    await enqueueScan(payload);
    res.status(202).json({ status: "queued", scanId, projectId: doc.id });
  } catch (err) {
    sendError(req, res, err);
  }
}

// Whether the scan should run synchronously inside the request. Tests and local
// emulator runs keep the async enqueue path (so the 202 contract is preserved);
// deployed runtimes default to synchronous because Cloud Tasks invocation of the
// worker requires a run.invoker IAM binding that may be missing. Override with
// SCAN_SYNC=1 / SCAN_SYNC=0.
function scanRunsSync(): boolean {
  if (process.env.SCAN_SYNC === "1") return true;
  if (process.env.SCAN_SYNC === "0") return false;
  return !process.env.FUNCTIONS_EMULATOR && !process.env.FIRESTORE_EMULATOR_HOST;
}

projectsRouter.post("/projects/:id/scan", rateLimit("project-scan", 6, 60_000), startScanHandler);
projectsRouter.post("/projects/:id/rescan", rateLimit("project-scan", 6, 60_000), startScanHandler);

// Latest scan status for the project (drives the progress UI + polling).
projectsRouter.get("/projects/:id/scan", async (req: AuthedRequest, res: Response) => {
  try {
    const owned = await ownedProject(req.userId!, String(req.params.id));
    if (!owned) {
      sendError(req, res, notFound());
      return;
    }
    const scan = await readLatestScan(req.userId!, owned.id);
    res.json({ scan: scan ?? null });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Assembled intelligence map snapshot (light nodes for fast first render).
projectsRouter.get("/projects/:id/scan/map", async (req: AuthedRequest, res: Response) => {
  try {
    const owned = await ownedProject(req.userId!, String(req.params.id));
    if (!owned) {
      sendError(req, res, notFound());
      return;
    }
    const map = await readMapPayload(req.userId!, owned.id);
    res.json({ map });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Full per-node detail (lazy-loaded on click in the sidebar).
projectsRouter.get("/projects/:id/nodes/:nodeId", async (req: AuthedRequest, res: Response) => {
  try {
    const owned = await ownedProject(req.userId!, String(req.params.id));
    if (!owned) {
      sendError(req, res, notFound());
      return;
    }
    const node = await readNodeDetail(req.userId!, owned.id, String(req.params.nodeId));
    if (!node) {
      sendError(req, res, notFound());
      return;
    }
    res.json({ node });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Interactive flow maps (Stage 1): one persisted document per (project, kind)
// in the `flow_maps` collection. `design` and `project` maps are independent.
type MapKind = "design" | "project";

function parseMapKind(value: unknown): MapKind | null {
  return value === "design" || value === "project" ? value : null;
}

async function findMap(userId: string, projectId: string, kind: MapKind) {
  const snap = await db
    .collection("flow_maps")
    .where("userId", "==", userId)
    .where("projectId", "==", projectId)
    .where("kind", "==", kind)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

projectsRouter.get("/projects/:id/map", async (req: AuthedRequest, res: Response) => {
  try {
    const owned = await ownedProject(req.userId!, String(req.params.id));
    if (!owned) {
      sendError(req, res, notFound());
      return;
    }
    const kind = parseMapKind(req.query.kind);
    if (!kind) {
      sendError(req, res, notFound());
      return;
    }
    const mapDoc = await findMap(req.userId!, owned.id, kind);
    res.json({ map: mapDoc ? { id: mapDoc.id, ...mapDoc.data() } : null });
  } catch (err) {
    sendError(req, res, err);
  }
});

projectsRouter.put("/projects/:id/map", async (req: AuthedRequest, res: Response) => {
  try {
    const owned = await ownedProject(req.userId!, String(req.params.id));
    if (!owned) {
      sendError(req, res, notFound());
      return;
    }
    const { kind, nodes, edges } = FlowMapSchema.parse(req.body);
    const existing = await findMap(req.userId!, owned.id, kind);
    if (existing) {
      await existing.ref.update({ nodes, edges, updatedAt: serverTime() });
      await logEvent(req.userId!, "flow_map_saved", kind, { projectId: owned.id, id: existing.id });
      res.json({ status: "saved", id: existing.id });
      return;
    }
    const ref = await db.collection("flow_maps").add({
      userId: req.userId,
      projectId: owned.id,
      kind,
      nodes,
      edges,
      createdAt: serverTime(),
      updatedAt: serverTime()
    });
    await logEvent(req.userId!, "flow_map_saved", kind, { projectId: owned.id, id: ref.id });
    res.json({ status: "saved", id: ref.id });
  } catch (err) {
    sendError(req, res, err);
  }
});
