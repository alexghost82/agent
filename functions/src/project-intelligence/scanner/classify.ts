import type { FileRole } from "../types";

const CONFIG_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "procfile",
  ".env.example",
  ".env.sample",
  ".env.template",
  "firebase.json",
  "vercel.json",
  "netlify.toml",
  "turbo.json",
  "nest-cli.json",
  "angular.json",
  "nuxt.config.ts",
  "nuxt.config.js"
]);

// Matches *.config.* and well-known framework config stems.
const CONFIG_RX = /(^|\/)(vite|next|nuxt|svelte|astro|webpack|rollup|babel|jest|vitest|playwright|tailwind|postcss|eslint|prettier|drizzle|tsup|esbuild)\.config\.[cm]?[jt]s$/i;

const SCHEMA_RX = /(^|\/)(schema\.prisma$|.*\.prisma$|schema\.(graphql|gql)$)/i;
const MIGRATION_RX = /(^|\/)(migrations?|prisma\/migrations)\//i;

// True for a React/Vue/Svelte component-ish path.
function isComponent(path: string, name: string): boolean {
  if (/\.(vue|svelte)$/i.test(name)) return true;
  if (!/\.(tsx|jsx)$/i.test(name)) return false;
  if (/(^|\/)(components?|ui|widgets?|views?)\//i.test(path)) return true;
  // PascalCase component file (Button.tsx) outside hooks/pages.
  return /^[A-Z][A-Za-z0-9]*\.(tsx|jsx)$/.test(name);
}

// Best-effort role classification from a file path. Pure + deterministic.
export function classifyFile(path: string): FileRole {
  const name = (path.split("/").pop() || "").toLowerCase();
  const lower = path.toLowerCase();

  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)(__tests__|tests?|e2e|cypress)\//.test(lower)) {
    return "test";
  }
  if (/\.(md|mdx)$/.test(name) || name === "readme" || /(^|\/)(docs?|adr)\//.test(lower)) return "doc";

  if (CONFIG_FILENAMES.has(name) || CONFIG_RX.test(lower) || /\.config\.[cm]?[jt]s$/.test(name)) return "config";
  if (SCHEMA_RX.test(lower) || /(^|\/)(models?|entities)\//.test(lower)) return "schema";
  if (MIGRATION_RX.test(lower)) return "migration";

  if (/\.(css|scss|sass|less|styl)$/.test(name)) return "style";

  if (/(^|\/)(workers?|queues?|jobs?|crons?|tasks?)\//.test(lower) || /\.(worker|job|cron|queue)\.[cm]?[jt]s$/.test(name)) {
    return "worker";
  }

  // API routes / controllers / Next app+pages router endpoints.
  if (
    /(^|\/)(routes?|controllers?|api)\//.test(lower) ||
    /\.(route|controller)\.[cm]?[jt]s$/.test(name) ||
    /(^|\/)(pages|app)\/.*\/(route|page|api)\.[cm]?[jt]sx?$/.test(lower) ||
    name === "route.ts" ||
    name === "route.js"
  ) {
    return "route";
  }

  if (isComponent(path, name)) return "component";
  if (/(^|\/)hooks?\//.test(lower) || /^use[A-Z].*\.[cm]?[jt]sx?$/.test(path.split("/").pop() || "")) return "hook";
  if (/(^|\/)(stores?|state)\//.test(lower) || /\.(store|slice|reducer)\.[cm]?[jt]s$/.test(name)) return "store";
  if (/(^|\/)(services?|lib|libs|server|backend)\//.test(lower) || /\.service\.[cm]?[jt]s$/.test(name)) return "service";

  if (/\.([cm]?[jt]sx?|vue|svelte|py|go|rb|java|kt|rs|php|cs)$/.test(name)) return "source";
  return "other";
}
