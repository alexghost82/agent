import type { LanguageAdapter, AnalyzedModule, ImportRef, ScannedFile } from "../../types";
import { externalPackageName, resolveInternalImport } from "./types";

// Strip line + block comments so commented-out imports don't pollute the graph.
// Intentionally simple (may touch comment-like substrings inside strings) — good
// enough for a heuristic import graph and far cheaper than a real parser.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const IMPORT_FROM_RX = /\bimport\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
const EXPORT_FROM_RX = /\bexport\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)["']([^"']+)["']/g;
const REQUIRE_RX = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT_RX = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_NAME_RX = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;

// Common tsconfig path aliases. Each prefix may map to several candidate roots
// (e.g. "@/" → "src/" or "app/"); resolution is best-effort against the file set.
const ALIAS_ROOT_SETS: Record<string, string>[] = [
  { "@/": "src/", "~/": "src/", "@app/": "app/" },
  { "@/": "app/", "~/": "app/" },
  { "@/": "", "~/": "" }
];

function collect(rx: RegExp, src: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  rx.lastIndex = 0;
  while ((m = rx.exec(src)) !== null) out.push(m[1]);
  return out;
}

export const jstsAdapter: LanguageAdapter = {
  id: "js-ts",
  matches(file: ScannedFile): boolean {
    return file.language === "typescript" || file.language === "javascript";
  },
  analyze(file: ScannedFile, internalPaths: Set<string>): AnalyzedModule {
    const src = stripComments(file.content || "");
    const specifiers = new Set<string>([
      ...collect(IMPORT_FROM_RX, src),
      ...collect(EXPORT_FROM_RX, src),
      ...collect(REQUIRE_RX, src),
      ...collect(DYNAMIC_IMPORT_RX, src)
    ]);

    const imports: ImportRef[] = [];
    for (const raw of specifiers) {
      const isRelativeOrAlias = raw.startsWith(".") || raw.startsWith("@/") || raw.startsWith("~/") || raw.startsWith("@app/");
      if (isRelativeOrAlias) {
        let resolved: string | null = null;
        for (const roots of ALIAS_ROOT_SETS) {
          resolved = resolveInternalImport(file.path, raw, internalPaths, roots);
          if (resolved) break;
        }
        if (resolved) imports.push({ raw, resolvedPath: resolved });
        else imports.push({ raw });
      } else if (raw.startsWith("node:")) {
        imports.push({ raw, external: raw });
      } else {
        imports.push({ raw, external: externalPackageName(raw) });
      }
    }

    const exports = Array.from(new Set(collect(EXPORT_NAME_RX, src))).slice(0, 50);
    return { path: file.path, imports, exports };
  }
};
