import { db } from "./firebase";
import { serverTime, logEvent, createProjectWithReadableId } from "./util";
import { bumpCounter } from "./stats";
import { ingestUrl } from "./learn";
import { extractSkillsForTopic } from "./skillsCore";
import { selectSkillsForTask, type SelectableSkill } from "./pure";
import { runDesignCore } from "./designCore";
import { runPlanCore } from "./plan";
import { runBuildCore } from "./buildJob";
import { recordUsage } from "./usage";

// Autonomous agent (Autopilot) orchestration. ONE run drives the whole cycle:
// learn → extract skills → auto-pick skills → design → plan → verified build.
// It reuses the exact same maintained building blocks as the individual routes
// (ingestUrl, extractSkillsForTopic, runDesignCore, runPlanCore, runBuildCore),
// so the security model (SSRF guard, read-only GitHub, sandboxed verification,
// encrypted keys) and behaviour stay identical. The heavy work is slow and runs
// out of band as an async AI job (see aiJobs.ts); progress is streamed into the
// `agent_runs` doc (status + steps) so the UI can poll it live.

interface AgentStep {
  name: string;
  status: string;
  detail?: string;
}

export interface AgentRunParams {
  userId: string;
  // The pre-created `agent_runs` doc id this run streams progress into.
  runId: string;
  urls: string[];
  task: string;
  deep?: boolean;
  lang?: string;
}

export interface AgentRunResult {
  topicId: string;
  projectId: string;
  buildRunId: string;
  fileCount: number;
}

function verificationStatus(v: unknown): string {
  if (v && typeof v === "object") return String((v as { status?: unknown }).status ?? "");
  return "";
}

export async function runAgentCore(p: AgentRunParams): Promise<AgentRunResult> {
  const { userId, runId, urls, task, deep, lang } = p;
  const runRef = db.collection("agent_runs").doc(runId);
  const name = task.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 120) || "Agent run";
  const description = task.slice(0, 5000);

  const steps: AgentStep[] = [];
  // Each step records the phase that just COMPLETED; `status` (the run status)
  // records the phase now STARTING — exactly what the UI stepper polls.
  const pushStep = async (status: string, step: AgentStep): Promise<void> => {
    steps.push(step);
    await runRef.update({ status, steps, updatedAt: serverTime() });
  };

  // Topic + project for this run.
  const topicRef = await db.collection("topics").add({ userId, name, description, createdAt: serverTime() });
  await bumpCounter(userId, "topics");
  const projectId = await createProjectWithReadableId(
    {
      userId,
      name,
      description,
      stack: null,
      repoUrl: null,
      skillIds: [],
      summary: null,
      ingestStatus: "none",
      createdAt: serverTime()
    },
    name
  );
  const projectRef = db.collection("projects").doc(projectId);
  await bumpCounter(userId, "projects");
  await runRef.update({ topicId: topicRef.id, projectId, status: "learning", updatedAt: serverTime() });

  // 1) LEARN — ingest every URL (a single bad URL never aborts the run).
  let learned = 0;
  let chunks = 0;
  for (const url of urls) {
    try {
      const r = await ingestUrl({ userId, topicId: topicRef.id, url, deep });
      learned += 1;
      chunks += r.chunks;
    } catch (e) {
      await logEvent(userId, "agent_ingest_failed", url, {
        runId,
        message: e instanceof Error ? e.message : String(e)
      });
    }
  }
  await recordUsage(userId, "ingest");
  await pushStep("skilling", { name: "learning", status: "done", detail: `${learned}/${urls.length} urls, ${chunks} chunks` });

  // 2) SKILLS — extract reusable skills from the whole topic corpus.
  let extracted: { id: string; skillName: string; description: string; appliesTo: string[] }[] = [];
  try {
    const r = await extractSkillsForTopic(userId, topicRef.id, name);
    extracted = r.skills.map((s) => ({
      id: s.id,
      skillName: s.skillName,
      description: s.description,
      appliesTo: s.appliesTo
    }));
  } catch (e) {
    await logEvent(userId, "agent_skills_skipped", name, {
      runId,
      message: e instanceof Error ? e.message : String(e)
    });
  }

  // 3) AUTO-PICK skills for the task (the project starts with none).
  const selectable: SelectableSkill[] = extracted.map((s) => ({
    id: s.id,
    skillName: s.skillName,
    description: s.description,
    appliesTo: s.appliesTo
  }));
  const skillIds = selectSkillsForTask(selectable, task).map((s) => s.id);
  if (skillIds.length) await projectRef.update({ skillIds, updatedAt: serverTime() });
  await pushStep("designing", { name: "skilling", status: "done", detail: `${extracted.length} skills, ${skillIds.length} selected` });

  // 4) DESIGN — ground a design decision in the learned memory.
  await runDesignCore({ userId, projectId, section: null, topicIds: [topicRef.id], lang });
  await pushStep("planning", { name: "designing", status: "done" });

  // 5) PLAN — md files + exactly one orchestrator prompt.
  const plan = await runPlanCore({ userId, projectId, instructions: task, lang });
  await pushStep("building", { name: "planning", status: "done", detail: `${plan.files.length} docs` });

  // 6) BUILD — verified development with the auto-picked skills.
  const build = await runBuildCore({ userId, projectId, planId: plan.id, instructions: task, lang });

  steps.push({ name: "building", status: "done", detail: verificationStatus(build.verification) });
  await runRef.update({
    status: "ready",
    buildRunId: build.id,
    summary: build.summary,
    verification: build.verification,
    steps,
    updatedAt: serverTime()
  });
  await logEvent(userId, "agent_run_completed", name, {
    runId,
    projectId,
    buildRunId: build.id,
    files: build.fileCount,
    verification: verificationStatus(build.verification)
  });

  return { topicId: topicRef.id, projectId, buildRunId: build.id, fileCount: build.fileCount };
}
