// Pure helpers with no Firebase / network dependencies (safe to unit test).

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
