// Project Intelligence orchestrator: ties the pipeline together
// (scan → detect → analyze → graph → optional AI → persist) and drives the
// scan document through its phase transitions. Pure of transport concerns —
// the Cloud Tasks worker (functions/src/projectScan.ts) handles dispatch,
// ownership and supersession guards, then calls runProjectScan.

import type { ScanOptions } from "./types";
import { scanRepo } from "./scanner";
import { detectTechStack } from "./detectors/techStack";
import { detectFeatures } from "./detectors/features";
import { analyzeDependencies } from "./analyzers/dependencies";
import { analyzeRisk } from "./analyzers/risk";
import { buildGraph } from "./graph/build";
import { enrichWithAI } from "./ai/summarize";
import { persistScanGraph, updateScan } from "./storage/persist";

export interface RunProjectScanInput {
  userId: string;
  projectId: string;
  projectName: string;
  scanId: string;
  repoUrl: string;
  token?: string;
  options: ScanOptions;
}

export interface RunProjectScanDeps {
  scan?: typeof scanRepo;
  enrich?: typeof enrichWithAI;
}

export interface RunProjectScanResult {
  branch: string;
  truncated: boolean;
  aiUsed: boolean;
  counts: { files: number; nodes: number; edges: number; technologies: number; features: number; insights: number };
}

// Runs the full analysis pipeline for one scan. Throws on failure so the worker
// can mark the scan failed (and let Cloud Tasks retry transient errors).
export async function runProjectScan(
  input: RunProjectScanInput,
  deps: RunProjectScanDeps = {}
): Promise<RunProjectScanResult> {
  const scanFn = deps.scan ?? scanRepo;
  const enrichFn = deps.enrich ?? enrichWithAI;
  const { userId, projectId, scanId } = input;

  // Phase 1: fetch repository structure + bounded contents.
  await updateScan(scanId, { status: "scanning", phase: "fetching" });
  const result = await scanFn({
    repoUrl: input.repoUrl,
    token: input.token,
    onProgress: async (done, total) => {
      await updateScan(scanId, { progressDone: done, progressTotal: total });
    }
  });

  // Phase 2: detect / analyze / assemble graph.
  await updateScan(scanId, { status: "analyzing", phase: "detecting" });
  const technologies = detectTechStack(result.files);
  const features = detectFeatures(result.files);
  const depGraph = analyzeDependencies(result.files);
  const insights = analyzeRisk(result.files, depGraph);

  const built = buildGraph({
    projectName: input.projectName,
    files: result.files,
    technologies,
    features,
    graph: depGraph,
    insights,
    maxDepth: input.options.maxDepth
  });

  // Phase 3: optional AI enrichment (clearly marked, never blocks the scan).
  let nodes = built.nodes;
  let featuresOut = features;
  let insightsOut = insights;
  let aiUsed = false;
  if (input.options.ai) {
    await updateScan(scanId, { phase: "ai" });
    const enriched = await enrichFn({
      projectName: input.projectName,
      nodes,
      technologies,
      features,
      insights,
      userId
    });
    nodes = enriched.nodes;
    featuresOut = enriched.features;
    insightsOut = enriched.insights;
    aiUsed = enriched.aiUsed;
  }

  // Phase 4: persist (strip file content — index keeps path/size/lang/role only).
  await updateScan(scanId, { phase: "persisting" });
  const fileIndex = result.files.map((f) => ({
    path: f.path,
    size: f.size,
    language: f.language,
    role: f.role
  }));
  await persistScanGraph({
    userId,
    projectId,
    scanId,
    nodes,
    edges: built.edges,
    technologies,
    features: featuresOut,
    insights: insightsOut,
    fileIndex
  });

  const counts = {
    files: result.files.length,
    nodes: nodes.length,
    edges: built.edges.length,
    technologies: technologies.length,
    features: featuresOut.length,
    insights: insightsOut.length
  };
  await updateScan(scanId, {
    status: "completed",
    phase: "done",
    branch: result.branch,
    truncated: result.truncated,
    aiUsed,
    counts,
    completedAt: new Date()
  });

  return { branch: result.branch, truncated: result.truncated, aiUsed, counts };
}
