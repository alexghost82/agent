import { llm } from "../../ai";
import { safeJsonObject } from "../../pure";
import { log } from "../../log";
import type { IntelNode, Technology, Feature, Insight } from "../types";

export interface EnrichInput {
  projectName: string;
  nodes: IntelNode[];
  technologies: Technology[];
  features: Feature[];
  insights: Insight[];
  userId: string;
}

export interface EnrichResult {
  nodes: IntelNode[];
  features: Feature[];
  insights: Insight[];
  aiUsed: boolean;
}

// Compact, SECRET-FREE structural context for the model. We send only labels,
// roles, counts and detected names — never file contents or env values.
function buildContext(input: EnrichInput): string {
  const techs = input.technologies.map((t) => t.name).slice(0, 40);
  const features = input.features.map((f) => ({ key: f.key, label: f.label, files: f.files.length }));
  const routes = input.nodes.filter((n) => n.type === "apiRoute").map((n) => n.label).slice(0, 40);
  const models = input.nodes.filter((n) => n.type === "dbModel").map((n) => n.label).slice(0, 30);
  const services = input.nodes.filter((n) => n.type === "service").map((n) => n.label).slice(0, 40);
  const modules = input.nodes.filter((n) => n.type === "module").map((n) => n.label).slice(0, 40);
  return JSON.stringify({ project: input.projectName, technologies: techs, features, modules, routes, services, models });
}

// Optionally enrich the graph with AI-generated, clearly-marked ("inferred")
// explanations. NEVER throws into the scan pipeline: on any failure (including
// no API key) it returns the inputs unchanged with aiUsed=false.
export async function enrichWithAI(input: EnrichInput): Promise<EnrichResult> {
  const fallback: EnrichResult = {
    nodes: input.nodes,
    features: input.features,
    insights: input.insights,
    aiUsed: false
  };

  try {
    const system =
      "You are a principal software architect performing READ-ONLY analysis. " +
      "Given a project's detected structure (no source code is provided), explain it. " +
      "Everything you produce is an INFERENCE from structure, not confirmed by reading code. " +
      "Reply ONLY with strict JSON matching: " +
      '{"summary": string, "features": [{"key": string, "purpose": string}], "userFlows": [string], "risks": [string]}. ' +
      "Keep summary <= 600 chars, each purpose <= 200 chars, max 6 userFlows, max 6 risks.";
    const user = `PROJECT STRUCTURE:\n${buildContext(input).slice(0, 9000)}`;

    const raw = await llm(system, user, 0.2, input.userId);
    const parsed = safeJsonObject(raw);
    if (!parsed) return fallback;

    const nodes = input.nodes.map((n) => ({ ...n }));
    const features = input.features.map((f) => ({ ...f }));
    const insights = [...input.insights];

    // Project summary → root node (marked inferred).
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      const root = nodes.find((n) => n.type === "project");
      if (root) {
        root.description = parsed.summary.trim().slice(0, 600);
        root.confidence = "inferred";
        root.metadata = { ...root.metadata, aiSummary: true };
      }
    }

    // Per-feature purpose → feature nodes + feature records.
    if (Array.isArray(parsed.features)) {
      for (const item of parsed.features) {
        if (!item || typeof item.key !== "string" || typeof item.purpose !== "string") continue;
        const purpose = item.purpose.trim().slice(0, 200);
        const feat = features.find((f) => f.key === item.key);
        if (feat) feat.description = purpose;
        const node = nodes.find((n) => n.type === "feature" && n.metadata?.key === item.key);
        if (node) {
          node.description = purpose;
          node.confidence = "inferred";
          node.metadata = { ...node.metadata, aiInferred: true };
        }
      }
    }

    // User flows + AI risks become "inferred" insights so they surface in the UI.
    let seq = 0;
    const pushNotes = (items: unknown, title: string, kind: "note") => {
      if (!Array.isArray(items)) return;
      for (const it of items.slice(0, 6)) {
        if (typeof it !== "string" || !it.trim()) continue;
        insights.push({
          id: `insight-ai-${kind}-${seq++}`,
          kind,
          severity: "info",
          title,
          detail: it.trim().slice(0, 400),
          confidence: "inferred"
        });
      }
    };
    pushNotes(parsed.userFlows, "User flow (inferred)", "note");
    pushNotes(parsed.risks, "Potential risk (inferred)", "note");

    return { nodes, features, insights, aiUsed: true };
  } catch (err) {
    log("warn", "scan_ai_enrich_failed", { message: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}
