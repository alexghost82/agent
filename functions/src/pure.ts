// Pure helpers with no Firebase / network dependencies (safe to unit test).

import { createHash } from "node:crypto";

export function chunkText(text: string, maxChars = 2200): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += maxChars) chunks.push(clean.slice(i, i + maxChars));
  return chunks.filter(Boolean);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export function safeJsonArray(raw: string): any[] {
  try {
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeJsonObject(raw: string): any | null {
  try {
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Sort helper for Firestore Timestamp-like values (newest first) without orderBy.
export function tsMillis(v: any): number {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v._seconds === "number") return v._seconds * 1000;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

export function parseRepoUrl(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/\.git$/i, "");
  // Accept full URLs and shorthand owner/repo.
  const m = trimmed.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i);
  if (m) return { owner: m[1], repo: m[2] };
  const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2] };
  throw new Error("Invalid GitHub repository URL");
}

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "txt", "yml", "yaml",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cc",
  "cs", "php", "sh", "bash", "zsh", "sql", "html", "htm", "css", "scss", "less",
  "vue", "svelte", "toml", "ini", "env", "xml", "gradle", "dockerfile", "graphql", "prisma"
]);

const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "readme", "license", ".gitignore", ".env.example", "procfile"
]);

export function isTextFile(path: string): boolean {
  const name = path.split("/").pop() || "";
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = lower.slice(dot + 1);
  return TEXT_EXTENSIONS.has(ext);
}

// --- Build (real development) helpers (CONTRACT v2.2) ----------------------

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", json: "json", md: "markdown",
  mdx: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp",
  hpp: "cpp", cc: "cpp", cs: "csharp", php: "php", sh: "shell", bash: "shell",
  zsh: "shell", sql: "sql", html: "html", htm: "html", css: "css",
  scss: "scss", less: "less", vue: "vue", svelte: "svelte", toml: "toml",
  yml: "yaml", yaml: "yaml", xml: "xml", gradle: "gradle", graphql: "graphql",
  prisma: "prisma", dockerfile: "dockerfile"
};

// Best-effort language tag from a file path's extension (or known filename).
export function detectLanguage(path: string): string | null {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return EXT_LANGUAGE[name.slice(dot + 1)] ?? null;
}

// Normalize a model-proposed artifact path into a safe relative path, or null
// if it is unsafe/unusable. Rejects absolute paths, `..` traversal, NUL bytes,
// and empty results. Backslashes are normalized to forward slashes.
export function sanitizeArtifactPath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.includes("\0")) return null;
  let p = input.trim().replace(/\\/g, "/");
  // Drop leading slashes and any leading "./" segments.
  p = p.replace(/^\/+/, "");
  const segments = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!segments.length) return null;
  if (segments.some((s) => s === "..")) return null;
  const joined = segments.join("/");
  if (joined.length === 0 || joined.length > 1024) return null;
  return joined;
}

export interface BuildFile {
  path: string;
  content: string;
  language: string | null;
  bytes: number;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

// Static, safe verification of generated build files (CONTRACT v3.1). No code is
// executed: presence, path safety, JSON validity, and a recognizable entry file.
export function staticBuildChecks(files: BuildFile[]): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  checks.push({ name: "files_present", ok: files.length > 0, detail: `${files.length} file(s)` });

  const unsafe = files.filter((f) => sanitizeArtifactPath(f.path) !== f.path);
  checks.push({ name: "paths_safe", ok: unsafe.length === 0, detail: unsafe.map((f) => f.path).join(", ") || undefined });

  const badJson = files
    .filter((f) => f.path.toLowerCase().endsWith(".json"))
    .filter((f) => {
      try { JSON.parse(f.content); return false; } catch { return true; }
    });
  checks.push({ name: "json_parses", ok: badJson.length === 0, detail: badJson.map((f) => f.path).join(", ") || undefined });

  const entryRx = /(^|\/)(package\.json|index\.(t|j)sx?|main\.(t|j)sx?|main\.py|Cargo\.toml|go\.mod|README\.md)$/i;
  const hasEntry = files.some((f) => entryRx.test(f.path));
  checks.push({ name: "entry_present", ok: hasEntry, detail: hasEntry ? undefined : "no recognizable entry/manifest file" });

  return checks;
}

// Truncate `content` to at most `maxBytes` UTF-8 bytes.
function truncateUtf8(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return content;
  return buf.subarray(0, maxBytes).toString("utf8");
}

// --- Memory dedup (CONTRACT v2.1 / v3.4) -----------------------------------

// Stable dedup key for a knowledge chunk: sha256 of the whitespace-normalized
// content. Writers skip a chunk whose (userId, scope, topic|project, hash) pair
// already exists, so re-learning the same material does not duplicate memory.
export function contentHash(content: string): string {
  const normalized = String(content).replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// --- Deep ingest helpers (CONTRACT v3.5) -----------------------------------

// True when both URLs share the same host (same-origin crawl boundary).
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

// Extract <loc> URLs from a sitemap.xml body (handles urlset + sitemapindex).
export function parseSitemapUrls(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

// Resolve a possibly-relative href against a base, dropping the fragment.
// Returns null for unusable / non-http(s) links.
export function resolveCrawlUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

// --- Vector backend selection (CONTRACT v3.2) ------------------------------

export type VectorBackend = "memory" | "firestore";

// Pure selector so the backend choice is unit-testable without Firestore. Only
// the explicit "firestore" value opts into Vector Search; everything else
// (including unset) keeps the emulator-safe in-memory cosine default.
export function selectVectorBackend(env: string | undefined): VectorBackend {
  return env === "firestore" ? "firestore" : "memory";
}

// --- Skill v2 quality validation (CONTRACT v3.3) ---------------------------

export interface SkillQuality {
  score: number;
  rationale?: string;
}

export interface SkillLike {
  skillName?: unknown;
  description?: unknown;
  example?: unknown;
  template?: unknown;
  appliesTo?: unknown;
}

// Heuristic 0..1 quality score for an extracted skill. Pure + deterministic so
// extraction can drop low-value skills below SKILL_MIN_QUALITY (CONTRACT v3.3).
export function scoreExtractedSkill(s: SkillLike): SkillQuality {
  const name = typeof s.skillName === "string" ? s.skillName.trim() : "";
  const desc = typeof s.description === "string" ? s.description.trim() : "";
  const reasons: string[] = [];
  let score = 0;
  if (name.length >= 3) score += 0.25; else reasons.push("name too short");
  if (desc.length >= 20) score += 0.35; else reasons.push("description too short");
  if (typeof s.example === "string" && s.example.trim().length >= 10) score += 0.15;
  if (typeof s.template === "string" && s.template.trim().length >= 10) score += 0.15;
  if (Array.isArray(s.appliesTo) && s.appliesTo.length > 0) score += 0.1;
  score = Math.min(1, Math.round(score * 100) / 100);
  return { score, rationale: reasons.length ? reasons.join("; ") : "ok" };
}

// Validate + sanitize a raw `{path, content}[]` proposal from the model into
// safe, de-duplicated, bounded BuildFile records (CONTRACT v2.2).
export function normalizeBuildFiles(
  raw: unknown,
  maxFiles: number,
  maxFileBytes: number
): BuildFile[] {
  if (!Array.isArray(raw)) return [];
  const out: BuildFile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= maxFiles) break;
    const path = sanitizeArtifactPath((item as { path?: unknown })?.path);
    const rawContent = (item as { content?: unknown })?.content;
    if (!path || typeof rawContent !== "string") continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const content = truncateUtf8(rawContent, maxFileBytes);
    out.push({ path, content, language: detectLanguage(path), bytes: Buffer.byteLength(content, "utf8") });
  }
  return out;
}
