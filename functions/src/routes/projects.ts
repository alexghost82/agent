import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { tsMillis } from "../pure";
import { ingestRepo } from "../github";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { ProjectSchema, UpdateProjectSchema, ConnectGithubSchema, GithubTokenSchema } from "../schemas";

export const projectsRouter = Router();

async function ownedProject(userId: string, projectId: string) {
  const doc = await db.collection("projects").doc(projectId).get();
  if (!doc.exists || doc.data()?.userId !== userId) return null;
  return doc;
}

projectsRouter.get("/projects", async (req: AuthedRequest, res: Response) => {
  try {
    const snap = await db.collection("projects").where("userId", "==", req.userId).limit(200).get();
    const projects = snap.docs
      .map((d) => {
        const { ...data } = d.data();
        return { id: d.id, ...data };
      })
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    res.json({ projects });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "projects_failed" });
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
    await logEvent(req.userId!, "project_created", body.name, { id: ref.id });
    res.json({ id: ref.id, status: "created" });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "project_create_failed" });
  }
});

projectsRouter.patch("/projects/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await ownedProject(req.userId!, String(req.params.id));
    if (!doc) {
      res.status(404).json({ error: "Project not found" });
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
  } catch (err: any) {
    res.status(400).json({ error: err.message || "project_update_failed" });
  }
});

// Store a per-user GitHub token (server-side only, never returned to the client).
projectsRouter.post("/github-token", async (req: AuthedRequest, res: Response) => {
  try {
    const { token } = GithubTokenSchema.parse(req.body);
    await db.collection("users").doc(req.userId!).update({ githubToken: token });
    res.json({ status: "saved" });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "github_token_failed" });
  }
});

// Read-only ingestion: indexes the repository into memory. Never writes to GitHub.
projectsRouter.post(
  "/projects/:id/connect-github",
  rateLimit("connect-github", 6, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const doc = await ownedProject(req.userId!, String(req.params.id));
      if (!doc) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const { repoUrl } = ConnectGithubSchema.parse(req.body);
      const userDoc = await db.collection("users").doc(req.userId!).get();
      const token: string | undefined = userDoc.data()?.githubToken || undefined;

      await doc.ref.update({ repoUrl, ingestStatus: "ingesting", updatedAt: serverTime() });
      const result = await ingestRepo({ userId: req.userId!, projectId: doc.id, repoUrl, token });
      await doc.ref.update({
        repoUrl,
        defaultBranch: result.branch,
        summary: result.summary,
        ingestStatus: "ready",
        ingestedFiles: result.filesIndexed,
        ingestedChunks: result.chunks,
        ingestedAt: serverTime()
      });
      await logEvent(req.userId!, "github_ingested", repoUrl, {
        projectId: doc.id,
        files: result.filesIndexed,
        chunks: result.chunks
      });
      res.json({ status: "ready", ...result });
    } catch (err: any) {
      const doc = await ownedProject(req.userId!, String(req.params.id));
      if (doc) await doc.ref.update({ ingestStatus: "error" });
      res.status(400).json({ error: err.message || "connect_github_failed" });
    }
  }
);
