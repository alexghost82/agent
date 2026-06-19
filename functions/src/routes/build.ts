import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { rateLimit } from "../ratelimit";
import { distributedRateLimit } from "../security";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { sendError, notFound } from "../errors";
import { BuildSchema } from "../schemas";
import { runBuild } from "../build";
import { verifyBuild } from "../sandbox";
import { recordOutcome } from "../learn";
import { recordUsage } from "../usage";

export const buildRouter = Router();

const ARTIFACT_WRITE_BATCH = 400;

// List build runs for the caller (optionally narrowed to one project).
buildRouter.get("/builds", async (req: AuthedRequest, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const runs = await listScoped({
      collection: "build_runs",
      userId: req.userId!,
      where: projectId ? [["projectId", projectId]] : [],
      limit: 50
    });
    res.json({ runs });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Fetch a single owned build run together with its generated artifacts.
buildRouter.get("/builds/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await db.collection("build_runs").doc(String(req.params.id)).get();
    if (!doc.exists || doc.data()?.userId !== req.userId) {
      sendError(req, res, notFound());
      return;
    }
    const artifacts = await listScoped({
      collection: "build_artifacts",
      userId: req.userId!,
      where: [["buildRunId", doc.id]],
      limit: 200
    });
    artifacts.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    res.json({ run: { id: doc.id, ...doc.data() }, artifacts });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Real-development BUILD: generates real project files from the plan + skills +
// memory into an isolated Firestore workspace. NEVER writes to GitHub.
buildRouter.post(
  "/projects/:id/build",
  rateLimit("build", 6, 60_000),
  distributedRateLimit("build", 40, 3_600_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { planId, instructions, lang } = BuildSchema.parse(req.body);
      const projectId = String(req.params.id);

      const projDoc = await db.collection("projects").doc(projectId).get();
      if (!projDoc.exists || projDoc.data()?.userId !== req.userId) {
        sendError(req, res, notFound());
        return;
      }
      const project = projDoc.data()!;

      // Optional source plan must be owned by the caller.
      let plan: { files?: { path: string; content: string }[]; prompts?: { title?: string; content: string }[] } | null = null;
      if (planId) {
        const planDoc = await db.collection("generated_plans").doc(planId).get();
        if (!planDoc.exists || planDoc.data()?.userId !== req.userId) {
          sendError(req, res, notFound());
          return;
        }
        const pd = planDoc.data()!;
        plan = { files: pd.files, prompts: pd.prompts };
      }

      // Create the run record up-front so the work is observable even if the
      // generation call fails midway.
      const runRef = await db.collection("build_runs").add({
        userId: req.userId,
        projectId,
        projectName: project.name,
        planId: planId || null,
        instructions: instructions || null,
        status: "running",
        fileCount: 0,
        summary: "",
        errorCode: null,
        createdAt: serverTime(),
        updatedAt: serverTime()
      });

      try {
        const result = await runBuild({
          userId: req.userId!,
          projectId,
          project: {
            name: project.name,
            description: project.description,
            stack: project.stack,
            summary: project.summary,
            skillIds: project.skillIds || []
          },
          plan,
          instructions,
          lang
        });

        // Persist each generated file as an owned artifact.
        for (let i = 0; i < result.files.length; i += ARTIFACT_WRITE_BATCH) {
          const slice = result.files.slice(i, i + ARTIFACT_WRITE_BATCH);
          const batch = db.batch();
          slice.forEach((f) => {
            const ref = db.collection("build_artifacts").doc();
            batch.set(ref, {
              userId: req.userId,
              buildRunId: runRef.id,
              projectId,
              path: f.path,
              content: f.content,
              language: f.language,
              bytes: f.bytes,
              createdAt: serverTime()
            });
          });
          await batch.commit();
        }

        // Materialize + verify the generated files in an ephemeral sandbox
        // (CONTRACT v3.1). Static, safe checks by default; never executes
        // untrusted code or writes to any external git remote.
        const verification = await verifyBuild(runRef.id, result.files);

        await runRef.update({
          status: "ready",
          fileCount: result.files.length,
          summary: result.summary,
          verification,
          updatedAt: serverTime()
        });
        // Self-learning (CONTRACT v3.4): feed the build outcome back into memory.
        await recordOutcome({
          userId: req.userId!,
          projectId,
          kind: "build_outcome",
          title: `Build: ${project.name}`,
          content: `${result.summary}\n\nFiles:\n${result.files.map((f) => `- ${f.path}`).join("\n")}`
        });
        await recordUsage(req.userId!, "build");
        await logEvent(req.userId!, "build_completed", project.name, {
          projectId,
          buildRunId: runRef.id,
          files: result.files.length
        });
        res.json({ id: runRef.id, status: "ready", files: result.files, summary: result.summary, fileCount: result.files.length, verification });
      } catch (genErr) {
        // Mark the run as errored with a stable-ish code, then surface via the
        // shared error envelope (§1).
        const code = genErr instanceof Error && genErr.message === "no_api_key" ? "no_api_key" : "internal";
        await runRef.update({ status: "error", errorCode: code, updatedAt: serverTime() }).catch(() => undefined);
        throw genErr;
      }
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
