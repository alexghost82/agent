// Directories that must never be scanned (vendored deps, build output, caches,
// VCS internals, logs). Keeping these out is both a correctness and a
// cost/safety requirement (no node_modules graphs, no secrets).
export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  "turbo",
  ".turbo",
  "out",
  "vendor",
  "logs",
  ".idea",
  ".vscode",
  ".output",
  "__pycache__"
];

const EXCLUDED_SET = new Set(EXCLUDED_DIRS);

// True when any path segment is an excluded directory.
export function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  // Drop the filename — only directory segments gate exclusion.
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_SET.has(segments[i])) return true;
  }
  return false;
}

// A "secret" file whose CONTENTS must never be fetched/stored or sent to AI.
// `.env.example` / `.env.sample` are templates (no real secrets) and are
// allowed as config files, but even then we only record their PRESENCE.
export function isSecretFile(path: string): boolean {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (name === ".env.example" || name === ".env.sample" || name === ".env.template") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".pfx")) return true;
  if (name === "id_rsa" || name === "credentials.json" || name === "serviceaccount.json") return true;
  return false;
}
