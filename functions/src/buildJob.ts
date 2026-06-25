import { db } from "./firebase";
import { serverTime, logEvent } from "./util";
import { notFound } from "./errors";
import { normalizeLang } from "./lang";
import { runVerifiedBuild } from "./build";
import { recordOutcome } from "./learn";
import { recordUsage } from "./usage";
import { bumpCounter } from "./stats";

// Core verified-build (the slow, LLM-bound work). Extracted from the route so it
// can run in a background Cloud Tasks worker (see aiJobs.ts), past Firebase
// Hosting's 60s rewrite timeout. The build_run doc is created here so the run is
// observable while it executes; generated files are persisted as build_artifacts
// (NOT inlined in the job result, which must stay under Firestore's 1 MB limit).

const ARTIFACT_WRITE_BATCH = 400;

export interface BuildCoreParams {
  userId: string;
  projectId: string;
  planId?: string;
  instructions?: string;
  lang?: string;
}

export interface BuildCoreResult {
  id: string;
  status: "ready";
  fileCount: number;
  summary: string;
  verification: unknown;
  autofixed: boolean;
}

export async function runBuildCore(p: BuildCoreParams): Promise<BuildCoreResult> {
  const { userId, projectId, planId, instructions, lang } = p;

  const projDoc = await db.collection("projects").doc(projectId).get();
  if (!projDoc.exists || projDoc.data()?.userId !== userId) throw notFound();
  const project = projDoc.data()!;

  // Optional source plan must be owned by the caller.
  let plan: { files?: { path: string; content: string }[]; prompts?: { title?: string; content: string }[] } | null = null;
  if (planId) {
    const planDoc = await db.collection("generated_plans").doc(planId).get();
    if (!planDoc.exists || planDoc.data()?.userId !== userId) throw notFound();
    const pd = planDoc.data()!;
    plan = { files: pd.files, prompts: pd.prompts };
  }

  // Create the run record up-front so the work is observable even if the
  // generation call fails midway.
  const runRef = await db.collection("build_runs").add({
    userId,
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
    // Generate → verify → (optional) ONE auto-fix pass, keeping the better
    // attempt (Epic 4.2). Never executes untrusted code on the shared process
    // nor writes to any git remote.
    const result = await runVerifiedBuild(runRef.id, {
      userId,
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
      lang: lang ? normalizeLang(lang) : undefined
    });
    const verification = result.verification;

    // Persist each FINAL generated file as an owned artifact.
    for (let i = 0; i < result.files.length; i += ARTIFACT_WRITE_BATCH) {
      const slice = result.files.slice(i, i + ARTIFACT_WRITE_BATCH);
      const batch = db.batch();
      slice.forEach((f) => {
        const ref = db.collection("build_artifacts").doc();
        batch.set(ref, {
          userId,
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

    await runRef.update({
      status: "ready",
      fileCount: result.files.length,
      summary: result.summary,
      verification,
      autofixed: result.autofixed,
      updatedAt: serverTime()
    });
    // Self-learning (CONTRACT v3.4): feed the build outcome back into memory.
    await recordOutcome({
      userId,
      projectId,
      kind: "build_outcome",
      title: `Build: ${project.name}`,
      content: `${result.summary}\n\nFiles:\n${result.files.map((f) => `- ${f.path}`).join("\n")}`
    });
    await recordUsage(userId, "build");
    // Maintain the per-user build_runs counter the dashboard reads (Build Artifacts KPI).
    await bumpCounter(userId, "build_runs");
    await logEvent(userId, "build_completed", project.name, {
      projectId,
      buildRunId: runRef.id,
      files: result.files.length
    });

    return {
      id: runRef.id,
      status: "ready",
      fileCount: result.files.length,
      summary: result.summary,
      verification,
      autofixed: result.autofixed
    };
  } catch (genErr) {
    const code = genErr instanceof Error && genErr.message === "no_api_key" ? "no_api_key" : "internal";
    await runRef.update({ status: "error", errorCode: code, updatedAt: serverTime() }).catch(() => undefined);
    throw genErr;
  }
}
