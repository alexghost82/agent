import type { ScannedFile, AnalyzedModule, LanguageAdapter } from "../types";
import { jstsAdapter } from "./adapters/jsts";

// Registered language adapters. Add Python/Go/Java by pushing more adapters.
const ADAPTERS: LanguageAdapter[] = [jstsAdapter];

export interface DependencyGraph {
  modules: AnalyzedModule[];
  // Resolved internal file→file edges (deduped).
  fileEdges: { from: string; to: string }[];
  // External package → set of files that import it.
  externalUsage: Map<string, Set<string>>;
}

// Build the dependency graph by running the matching language adapter over each
// file that has content. Pure (no I/O) so it is fully unit-testable.
export function analyzeDependencies(files: ScannedFile[]): DependencyGraph {
  const internalPaths = new Set(files.map((f) => f.path));
  const modules: AnalyzedModule[] = [];
  const edgeKeys = new Set<string>();
  const fileEdges: { from: string; to: string }[] = [];
  const externalUsage = new Map<string, Set<string>>();

  for (const file of files) {
    if (!file.content) continue;
    const adapter = ADAPTERS.find((a) => a.matches(file));
    if (!adapter) continue;

    const mod = adapter.analyze(file, internalPaths);
    modules.push(mod);

    for (const imp of mod.imports) {
      if (imp.resolvedPath && imp.resolvedPath !== file.path) {
        const key = `${file.path}\u0000${imp.resolvedPath}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          fileEdges.push({ from: file.path, to: imp.resolvedPath });
        }
      } else if (imp.external) {
        let set = externalUsage.get(imp.external);
        if (!set) {
          set = new Set<string>();
          externalUsage.set(imp.external, set);
        }
        set.add(file.path);
      }
    }
  }

  return { modules, fileEdges, externalUsage };
}
