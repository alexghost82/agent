// Re-export the adapter contract and shared module-resolution helpers used by
// the per-language adapters. Adding a new language = implementing LanguageAdapter
// and registering it in analyzers/dependencies.ts — nothing else changes.

export type { LanguageAdapter, AnalyzedModule, ImportRef, ScannedFile } from "../../types";

// Normalize a POSIX-style path, collapsing "." and ".." segments.
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// The package name for a bare specifier: "@scope/pkg/sub" → "@scope/pkg",
// "pkg/sub" → "pkg". Strips any trailing query/hash.
export function externalPackageName(spec: string): string {
  const clean = spec.split("?")[0].split("#")[0];
  const parts = clean.split("/");
  if (clean.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0];
}

const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"];

// Resolve a relative/alias import to an internal file path, or null when it
// doesn't map to a known file. `aliasRoots` maps tsconfig-style prefixes
// (e.g. "@/") to repo-relative roots (e.g. "src/" or "").
export function resolveInternalImport(
  fromPath: string,
  spec: string,
  internalPaths: Set<string>,
  aliasRoots: Record<string, string> = {}
): string | null {
  let base: string | null = null;

  if (spec.startsWith(".")) {
    const dir = fromPath.split("/").slice(0, -1).join("/");
    base = normalizePath(`${dir}/${spec}`);
  } else {
    // Try alias prefixes (longest first) e.g. "@/", "~/", "@app/".
    const prefixes = Object.keys(aliasRoots).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      if (spec === prefix.replace(/\/$/, "") || spec.startsWith(prefix)) {
        const rest = spec.slice(prefix.length);
        base = normalizePath(`${aliasRoots[prefix]}/${rest}`);
        break;
      }
    }
  }
  if (base == null) return null;

  for (const ext of CANDIDATE_EXTS) {
    const candidate = `${base}${ext}`;
    if (candidate && internalPaths.has(candidate)) return candidate;
  }
  for (const idx of INDEX_FILES) {
    const candidate = base ? `${base}/${idx}` : idx;
    if (internalPaths.has(candidate)) return candidate;
  }
  return null;
}
