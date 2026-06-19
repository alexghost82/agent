import { Router, Response } from "express";
import * as crypto from "crypto";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { encryptSecret } from "../crypto";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { enqueueIngest } from "../tasks";
import { ProjectSchema, UpdateProjectSchema, ConnectGithubSchema, GithubTokenSchema } from "../schemas";

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
