// Map export builders (JSON + Markdown) and a tiny download helper.
//
// Extracted from ProjectMap.tsx so they can be reused by the GhostMap renderer
// without importing React Flow. ProjectMap.tsx re-exports these for backwards
// compatibility (and its unit tests).

import type { ProjectMapData } from "./ProjectMap";
import type { ProjectMapNode } from "../types/projectMap";

interface RawNodeLike {
  id: string;
  type?: string;
  label?: string;
  description?: string;
  tags?: string[];
  files?: string[];
  details?: ProjectMapNode["details"];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const titleOf = (n: RawNodeLike | ProjectMapNode): string =>
  (n as ProjectMapNode).title || n.label || n.id;
const kindOf = (n: RawNodeLike | ProjectMapNode): string =>
  ((n as ProjectMapNode).kind as string) || (n.type as string) || "file";

// Full JSON payload of the map (pretty-printed). Safe on partial data.
export function buildMapJson(data: ProjectMapData): string {
  return JSON.stringify(
    {
      scanId: data.scanId ?? null,
      status: data.status ?? null,
      generatedAt: data.generatedAt ?? null,
      summary: data.summary ?? null,
      stats: data.stats ?? { files: 0, nodes: 0, edges: 0 },
      technologies: data.technologies ?? [],
      features: data.features ?? [],
      dependencies: data.dependencies ?? [],
      risks: data.risks ?? [],
      insights: data.insights ?? [],
      fileIndex: data.fileIndex ?? [],
      groups: data.groups ?? [],
      nodes: data.nodes ?? [],
      edges: data.edges ?? []
    },
    null,
    2
  );
}

// Human-readable Markdown report. Each section is omitted gracefully when the
// underlying data is missing, so a legacy payload still produces valid output.
export function buildMapMarkdown(data: ProjectMapData, projectName = "Project"): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# ${projectName} — Project Map`);
  push();
  if (data.summary) {
    push("## Summary");
    push();
    push(str(data.summary).trim());
    push();
  }

  const s = data.stats || { files: 0, nodes: 0, edges: 0 };
  push("## Overview");
  push();
  push(`- Nodes: ${s.nodes ?? (data.nodes?.length || 0)}`);
  push(`- Edges: ${s.edges ?? (data.edges?.length || 0)}`);
  push(`- Files: ${s.files ?? (data.fileIndex?.length || 0)}`);
  push(`- Risks: ${s.risks ?? (data.risks?.length || 0)}`);
  push(`- Technologies: ${s.technologies ?? (data.technologies?.length || 0)}`);
  push();

  if (data.technologies?.length) {
    push("## Technologies");
    push();
    for (const tech of data.technologies) {
      const ver = tech.version ? ` \`${tech.version}\`` : "";
      push(`- **${tech.name}**${ver} — ${tech.category}${tech.confidence ? ` (${tech.confidence})` : ""}`);
    }
    push();
  }

  if (data.features?.length) {
    push("## Features");
    push();
    for (const f of data.features) {
      push(`- **${f.label}**${f.description ? ` — ${str(f.description)}` : ""}`);
    }
    push();
  }

  if (data.dependencies?.length) {
    push("## Dependencies");
    push();
    for (const d of data.dependencies) {
      push(`- ${d.name}${d.usedBy ? ` (used by ${d.usedBy} file(s))` : ""}`);
    }
    push();
  }

  if (data.risks?.length) {
    push("## Risks");
    push();
    for (const r of data.risks) {
      push(`- **[${r.severity}] ${r.title}** — ${str(r.detail)}`);
    }
    push();
  }

  if (data.nodes?.length) {
    push("## Nodes");
    push();
    for (const n of data.nodes) {
      push(`### ${titleOf(n)}`);
      push();
      push(`- Kind: \`${kindOf(n)}\``);
      if (n.description) push(`- Description: ${str(n.description)}`);
      const d = n.details;
      if (d) {
        if (d.purpose) push(`- Purpose: ${str(d.purpose)}`);
        if (d.stack?.length) push(`- Stack: ${d.stack.join(", ")}`);
        if (d.inputs?.length) push(`- Inputs: ${d.inputs.join("; ")}`);
        if (d.outputs?.length) push(`- Outputs: ${d.outputs.join("; ")}`);
        if (d.logic) push(`- Logic: ${str(d.logic)}`);
        if (d.risks?.length) push(`- Risks: ${d.risks.join("; ")}`);
        if (d.files?.length) push(`- Files: ${d.files.join(", ")}`);
      } else if (n.files?.length) {
        push(`- Files: ${n.files.join(", ")}`);
      }
      push();
    }
  }

  if (data.edges?.length) {
    push("## Edges");
    push();
    for (const e of data.edges) {
      push(`- ${e.source} → ${e.target}${e.label ? ` (${e.label})` : ""}`);
    }
    push();
  }

  if (data.fileIndex?.length) {
    push("## File index");
    push();
    for (const f of data.fileIndex) {
      push(`- \`${f.path}\`${f.role ? ` — ${f.role}` : ""}${f.language ? ` (${f.language})` : ""}`);
    }
    push();
  }

  if (data.insights?.length) {
    push("## Insights");
    push();
    for (const i of data.insights) {
      push(`- **[${i.severity}] ${i.title}** — ${str(i.detail)}`);
    }
    push();
  }

  return lines.join("\n");
}

// Trigger a client-side download via Blob (no extra dependency).
export function downloadText(filename: string, content: string, mime: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
