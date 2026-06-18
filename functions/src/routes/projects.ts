import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { ingestRepo } from "../github";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { encryptSecret, decryptSecret, EncryptedSecret } from "../crypto";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError, notFound } from "../errors";
import { log } from "../log";
import { ProjectSchema, UpdateProjectSchema, ConnectGithubSchema, GithubTokenSchema } from "../schemas";

export const projectsRouter = Router();

async function ownedProject(userId: string, projectId: string) {
  const doc = await db.collection("projects").doc(projectId).get();
  if (!doc.exists || doc.data()?.userId !== userId) return null;
  return doc;
}

// Reads the per-user GitHub token, decrypting the stored envelope. Supports a
// legacy plaintext value for backward compatibility during migration.
function readGithubToken(data: FirebaseFirestore.DocumentData | undefined, userId: string): string | undefined {
  const t = data?.githubToken;
  if (!t) return undefined;
  if (typeof t === "string") return t; // legacy plaintext (pre-encryption)
  const env = t as Partial<EncryptedSecret>;
  if (env.ciphertext && env.iv && env.tag) {
    try {
      return decryptSecret(env as EncryptedSecret);
    } catch {
      log("warn", "github_token_decrypt_failed", { userId });
      return undefined;
    }
  }
  return undefined;
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

// Read-only ingestion: indexes the repository into memory. Never writes to GitHub.
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
      const userDoc = await db.collection("users").doc(req.userId!).get();
      const token = readGithubToken(userDoc.data(), req.userId!);

      await doc.ref.update({ repoUrl, ingestStatus: "ingesting", ingestedFiles: 0, updatedAt: serverTime() });
      const result = await ingestRepo({
        userId: req.userId!,
        projectId: doc.id,
        repoUrl,
        token,
        onProgress: async (done, total) => {
          await doc.ref.update({ ingestedFiles: done, ingestTotalFiles: total });
        }
      });
      await doc.ref.update({
        repoUrl,
        defaultBranch: result.branch,
        summary: result.summary,
        ingestStatus: "ready",
        ingestedFiles: result.filesIndexed,
        ingestedChunks: result.chunks,
        ingestedAt: serverTime()
      });
      await bumpCounter(req.userId!, "knowledge_chunks", result.chunks);
      await logEvent(req.userId!, "github_ingested", repoUrl, {
        projectId: doc.id,
        files: result.filesIndexed,
        chunks: result.chunks
      });
      res.json({ status: "ready", ...result });
    } catch (err) {
      const doc = await ownedProject(req.userId!, String(req.params.id));
      if (doc) await doc.ref.update({ ingestStatus: "error" });
      sendError(req, res, err);
    }
  }
);
