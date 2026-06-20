import type { ScannedFile, Technology, TechCategory, Confidence } from "../types";

// Known npm package → technology mapping. Kept declarative so it is easy to
// extend. The first matching entry (exact name or prefix) wins.
interface PkgRule {
  match: string | RegExp;
  name: string;
  category: TechCategory;
}

const PKG_RULES: PkgRule[] = [
  // Frontend frameworks
  { match: "next", name: "Next.js", category: "frontend" },
  { match: "nuxt", name: "Nuxt", category: "frontend" },
  { match: "@angular/core", name: "Angular", category: "frontend" },
  { match: "svelte", name: "Svelte", category: "frontend" },
  { match: "vue", name: "Vue", category: "frontend" },
  { match: "react-dom", name: "React", category: "frontend" },
  { match: "react", name: "React", category: "frontend" },
  { match: "solid-js", name: "SolidJS", category: "frontend" },
  { match: "astro", name: "Astro", category: "frontend" },
  // Backend frameworks
  { match: "@nestjs/core", name: "NestJS", category: "backend" },
  { match: "fastify", name: "Fastify", category: "backend" },
  { match: "express", name: "Express", category: "backend" },
  { match: "koa", name: "Koa", category: "backend" },
  { match: "hono", name: "Hono", category: "backend" },
  { match: "@hapi/hapi", name: "hapi", category: "backend" },
  { match: "firebase-functions", name: "Firebase Functions", category: "backend" },
  // ORM / DB clients
  { match: "@prisma/client", name: "Prisma", category: "orm" },
  { match: "prisma", name: "Prisma", category: "orm" },
  { match: "drizzle-orm", name: "Drizzle", category: "orm" },
  { match: "typeorm", name: "TypeORM", category: "orm" },
  { match: "sequelize", name: "Sequelize", category: "orm" },
  { match: "mongoose", name: "Mongoose", category: "orm" },
  { match: "knex", name: "Knex", category: "orm" },
  // Databases / clients
  { match: "pg", name: "PostgreSQL", category: "database" },
  { match: "postgres", name: "PostgreSQL", category: "database" },
  { match: "mysql2", name: "MySQL", category: "database" },
  { match: "mysql", name: "MySQL", category: "database" },
  { match: "sqlite3", name: "SQLite", category: "database" },
  { match: "better-sqlite3", name: "SQLite", category: "database" },
  { match: "mongodb", name: "MongoDB", category: "database" },
  { match: "firebase-admin", name: "Firestore", category: "database" },
  { match: "firebase", name: "Firebase", category: "database" },
  // Auth
  { match: "next-auth", name: "NextAuth", category: "auth" },
  { match: "@auth/core", name: "Auth.js", category: "auth" },
  { match: "passport", name: "Passport", category: "auth" },
  { match: "@clerk/", name: "Clerk", category: "auth" },
  { match: "@supabase/supabase-js", name: "Supabase", category: "auth" },
  { match: "jsonwebtoken", name: "JWT", category: "auth" },
  { match: "lucia", name: "Lucia", category: "auth" },
  // State management
  { match: "redux", name: "Redux", category: "state" },
  { match: "@reduxjs/toolkit", name: "Redux Toolkit", category: "state" },
  { match: "zustand", name: "Zustand", category: "state" },
  { match: "jotai", name: "Jotai", category: "state" },
  { match: "recoil", name: "Recoil", category: "state" },
  { match: "mobx", name: "MobX", category: "state" },
  { match: "@tanstack/react-query", name: "TanStack Query", category: "state" },
  { match: "pinia", name: "Pinia", category: "state" },
  // UI kits
  { match: "@mui/material", name: "MUI", category: "uiKit" },
  { match: "antd", name: "Ant Design", category: "uiKit" },
  { match: "@chakra-ui/react", name: "Chakra UI", category: "uiKit" },
  { match: "@mantine/core", name: "Mantine", category: "uiKit" },
  { match: "tailwindcss", name: "Tailwind CSS", category: "uiKit" },
  { match: "@shadcn/ui", name: "shadcn/ui", category: "uiKit" },
  { match: "bootstrap", name: "Bootstrap", category: "uiKit" },
  // Testing
  { match: "vitest", name: "Vitest", category: "testing" },
  { match: "jest", name: "Jest", category: "testing" },
  { match: "mocha", name: "Mocha", category: "testing" },
  { match: "@playwright/test", name: "Playwright", category: "testing" },
  { match: "cypress", name: "Cypress", category: "testing" },
  { match: "@testing-library/react", name: "Testing Library", category: "testing" },
  // Build tools
  { match: "vite", name: "Vite", category: "build" },
  { match: "webpack", name: "Webpack", category: "build" },
  { match: "esbuild", name: "esbuild", category: "build" },
  { match: "rollup", name: "Rollup", category: "build" },
  { match: "turbo", name: "Turborepo", category: "build" },
  { match: "typescript", name: "TypeScript", category: "language" },
  // Queue / cache / search
  { match: "bullmq", name: "BullMQ", category: "queue" },
  { match: "bull", name: "Bull", category: "queue" },
  { match: "amqplib", name: "RabbitMQ", category: "queue" },
  { match: "kafkajs", name: "Kafka", category: "queue" },
  { match: "ioredis", name: "Redis", category: "cache" },
  { match: "redis", name: "Redis", category: "cache" },
  { match: "memcached", name: "Memcached", category: "cache" },
  { match: "@elastic/elasticsearch", name: "Elasticsearch", category: "search" },
  { match: "meilisearch", name: "Meilisearch", category: "search" },
  { match: "algoliasearch", name: "Algolia", category: "search" }
];

function matchPkg(dep: string): PkgRule | undefined {
  return PKG_RULES.find((r) =>
    typeof r.match === "string"
      ? dep === r.match || (r.match.endsWith("/") && dep.startsWith(r.match))
      : r.match.test(dep)
  );
}

// Config-file presence → technology (filename matched case-insensitively).
const FILE_RULES: { test: RegExp; name: string; category: TechCategory }[] = [
  { test: /(^|\/)dockerfile$/i, name: "Docker", category: "deploy" },
  { test: /(^|\/)docker-compose\.ya?ml$/i, name: "Docker Compose", category: "deploy" },
  { test: /(^|\/)firebase\.json$/i, name: "Firebase", category: "deploy" },
  { test: /(^|\/)vercel\.json$/i, name: "Vercel", category: "deploy" },
  { test: /(^|\/)netlify\.toml$/i, name: "Netlify", category: "deploy" },
  { test: /(^|\/)\.github\/workflows\//i, name: "GitHub Actions", category: "deploy" },
  { test: /(^|\/)serverless\.ya?ml$/i, name: "Serverless Framework", category: "deploy" },
  { test: /\.prisma$/i, name: "Prisma", category: "orm" },
  { test: /\.(graphql|gql)$/i, name: "GraphQL", category: "backend" },
  { test: /(^|\/)tsconfig\.json$/i, name: "TypeScript", category: "language" },
  { test: /(^|\/)kubernetes\//i, name: "Kubernetes", category: "deploy" },
  { test: /\.tf$/i, name: "Terraform", category: "deploy" }
];

// Lockfile → package manager.
const LOCKFILES: { test: RegExp; name: string }[] = [
  { test: /(^|\/)pnpm-lock\.yaml$/i, name: "pnpm" },
  { test: /(^|\/)yarn\.lock$/i, name: "Yarn" },
  { test: /(^|\/)bun\.lockb$/i, name: "Bun" },
  { test: /(^|\/)package-lock\.json$/i, name: "npm" }
];

function parseJsonSafe(content?: string): any | null {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Detect the project's technology stack from manifests, lockfiles and configs.
// Pure + deterministic so it is unit-testable without network/Firebase.
export function detectTechStack(files: ScannedFile[]): Technology[] {
  const found = new Map<string, Technology>();
  const add = (name: string, category: TechCategory, confidence: Confidence, evidence?: string, version?: string) => {
    const id = `tech-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const existing = found.get(id);
    if (existing) {
      // Upgrade confidence / fill version when a stronger signal arrives.
      if (confidence === "high") existing.confidence = "high";
      if (version && !existing.version) existing.version = version;
      return;
    }
    found.set(id, { id, name, category, confidence, evidence, version });
  };

  // package.json dependencies (strongest signal).
  const pkgFile = files.find((f) => /(^|\/)package\.json$/i.test(f.path) && f.content);
  const pkg = parseJsonSafe(pkgFile?.content);
  if (pkg) {
    const deps: Record<string, string> = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [dep, version] of Object.entries(deps)) {
      const rule = matchPkg(dep);
      if (rule) add(rule.name, rule.category, "high", `package.json (${dep})`, String(version).replace(/^[\^~]/, ""));
    }
    if (pkg.packageManager && typeof pkg.packageManager === "string") {
      const pm = pkg.packageManager.split("@")[0];
      if (pm) add(pm.charAt(0).toUpperCase() + pm.slice(1), "build", "high", "package.json packageManager");
    }
  }

  // Config-file presence + lockfiles (path-level signals).
  for (const f of files) {
    for (const rule of FILE_RULES) {
      if (rule.test.test(f.path)) add(rule.name, rule.category, "high", f.path);
    }
    for (const lf of LOCKFILES) {
      if (lf.test.test(f.path)) add(lf.name, "build", "high", f.path);
    }
  }

  // Language detection from file extensions present (medium confidence).
  const exts = new Set(files.map((f) => f.language).filter(Boolean) as string[]);
  if (exts.has("typescript")) add("TypeScript", "language", "high", "*.ts files");
  if (exts.has("javascript") && !exts.has("typescript")) add("JavaScript", "language", "medium", "*.js files");
  if (exts.has("python")) add("Python", "language", "medium", "*.py files");
  if (exts.has("go")) add("Go", "language", "medium", "*.go files");
  if (exts.has("rust")) add("Rust", "language", "medium", "*.rs files");
  if (exts.has("java")) add("Java", "language", "medium", "*.java files");

  return Array.from(found.values());
}
