import type { ScannedFile, Insight } from "../types";
import type { DependencyGraph } from "./dependencies";
import { isSecretFile } from "../scanner/exclude";

// Tunable thresholds (bytes / counts). Conservative so we only flag real smells.
const LARGE_FILE_BYTES = Number(process.env.SCAN_LARGE_FILE_BYTES) || 45_000;
const CRITICAL_FILE_BYTES = Number(process.env.SCAN_CRITICAL_FILE_BYTES) || 80_000;
const GOD_FILE_FANIN = Number(process.env.SCAN_GOD_FILE_FANIN) || 12;
const MAX_CYCLES = 12;
const MAX_LARGE = 15;

// Tarjan's strongly-connected-components: any component with >1 node (or a
// self-loop) is an import cycle.
function findCycles(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  const selfLoops = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) {
      selfLoops.add(e.from);
      continue;
    }
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  // Iterative Tarjan to avoid stack overflow on large graphs.
  const callStack: { node: string; childIdx: number }[] = [];
  for (const start of nodes) {
    if (indices.has(start)) continue;
    callStack.push({ node: start, childIdx: 0 });
    indices.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const neighbors = adj.get(frame.node) || [];
      if (frame.childIdx < neighbors.length) {
        const next = neighbors[frame.childIdx++];
        if (!indices.has(next)) {
          indices.set(next, index);
          low.set(next, index);
          index++;
          stack.push(next);
          onStack.add(next);
          callStack.push({ node: next, childIdx: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indices.get(next)!));
        }
      } else {
        if (low.get(frame.node) === indices.get(frame.node)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.node);
          if (comp.length > 1) sccs.push(comp);
        }
        callStack.pop();
        if (callStack.length) {
          const parent = callStack[callStack.length - 1];
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
      }
    }
  }

  for (const s of selfLoops) sccs.push([s]);
  return sccs;
}

// Derive risk/quality insights from the file set + dependency graph. Pure.
export function analyzeRisk(files: ScannedFile[], graph: DependencyGraph): Insight[] {
  const insights: Insight[] = [];
  let seq = 0;
  const nextId = (kind: string) => `insight-${kind}-${seq++}`;

  // 1) Import cycles.
  const cycles = findCycles(
    files.map((f) => f.path),
    graph.fileEdges
  );
  for (const cycle of cycles.slice(0, MAX_CYCLES)) {
    insights.push({
      id: nextId("cycle"),
      kind: "cycle",
      severity: "warning",
      title: `Circular dependency (${cycle.length} files)`,
      detail: `These files import each other in a cycle, which hurts testability and build/refactor safety: ${cycle.slice(0, 6).join(" \u2192 ")}${cycle.length > 6 ? " \u2026" : ""}`,
      files: cycle,
      confidence: "high"
    });
  }

  // 2) Large / god files (by size).
  const large = files
    .filter((f) => f.size >= LARGE_FILE_BYTES)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_LARGE);
  for (const f of large) {
    const critical = f.size >= CRITICAL_FILE_BYTES;
    insights.push({
      id: nextId("large"),
      kind: critical ? "god_file" : "large_file",
      severity: critical ? "critical" : "warning",
      title: `${critical ? "Very large" : "Large"} file: ${f.path.split("/").pop()}`,
      detail: `${f.path} is ~${Math.round(f.size / 1024)} KB. Large files are harder to understand and review; consider splitting it.`,
      files: [f.path],
      confidence: "high"
    });
  }

  // 3) God files by fan-in (imported by many modules).
  const fanIn = new Map<string, number>();
  for (const e of graph.fileEdges) fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1);
  for (const [path, count] of fanIn) {
    if (count >= GOD_FILE_FANIN && !large.some((f) => f.path === path)) {
      insights.push({
        id: nextId("hub"),
        kind: "god_file",
        severity: "warning",
        title: `Highly-coupled module: ${path.split("/").pop()}`,
        detail: `${path} is imported by ${count} modules. A change here ripples widely — treat it as a stable, well-tested boundary.`,
        files: [path],
        confidence: "high"
      });
    }
  }

  // 4) Secret files committed to the repo.
  const secrets = files.filter((f) => isSecretFile(f.path));
  if (secrets.length) {
    insights.push({
      id: nextId("secret"),
      kind: "secret_risk",
      severity: "critical",
      title: `Possible secret file(s) in the repo (${secrets.length})`,
      detail: `Files that usually hold secrets are present in the repository: ${secrets.map((f) => f.path).slice(0, 5).join(", ")}. Their contents were NOT read. Ensure they are gitignored and rotate any leaked credentials.`,
      files: secrets.map((f) => f.path),
      confidence: "high"
    });
  }

  // 5) No tests at all.
  const hasTests = files.some((f) => f.role === "test");
  const hasSource = files.some((f) => f.role === "source" || f.role === "service" || f.role === "component" || f.role === "route");
  if (hasSource && !hasTests) {
    insights.push({
      id: nextId("tests"),
      kind: "missing_tests",
      severity: "warning",
      title: "No tests detected",
      detail: "The scan found source code but no test files. Untested code is risky to change.",
      confidence: "medium"
    });
  }

  return insights;
}
