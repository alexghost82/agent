import { db } from "./firebase";
import { embeddingBatch, llm } from "./ai";
import { serverTime } from "./util";
import { chunkText, isTextFile, parseRepoUrl } from "./pure";
import { mapWithConcurrency } from "./concurrency";
import { toVector } from "./vector";
import { log } from "./log";
import { MAX_FILE_BYTES, getRepoInfo, fetchTree, fetchRawFile } from "./githubFetch";
import { classifyFile } from "./project-intelligence/scanner/classify";
import type { FileRole } from "./project-intelligence/types";

// File cap for ingestion, configurable via env (default raised 200 -> 400).
const MAX_FILES = Number(process.env.GITHUB_INGEST_MAX_FILES) || 400;
const FETCH_CONCURRENCY = Number(process.env.GITHUB_FETCH_CONCURRENCY) || 8;
const EMBED_BATCH = Number(process.env.EMBED_BATCH_SIZE) || 96;
const WRITE_BATCH = 400;

// Absolute upper bound on a single file's fetched content, regardless of any env
// override (mirrors githubFetch.MAX_FILE_BYTES_CEILING; kept local so this module
// stays decoupled from that export for mocking).
const MAX_FILE_BYTES_CEILING = 2_000_000;

// Per-file byte budget for the tree size filter and raw fetch. Mirrors
// githubFetch.resolveMaxFileBytes but kept local so it also works when callers
// mock githubFetch with only MAX_FILE_BYTES exported. Clamped to the ceiling.
const MAX_FILE_BYTES_LIMIT = Math.min(
  Number(process.env.GITHUB_MAX_FILE_BYTES) > 0 ? Number(process.env.GITHUB_MAX_FILE_BYTES) : MAX_FILE_BYTES,
  MAX_FILE_BYTES_CEILING
);

// Roles whose CONTENT is high-value for analysis — prioritized first when
// selecting which files to ingest. Mirrors PRIORITY_ROLES in the scanner
// (project-intelligence/scanner/index.ts) so both pipelines agree on value.
const PRIORITY_ROLES: ReadonlySet<FileRole> = new Set<FileRole>([
  "config",
  "schema",
  "migration",
  "route",
  "service",
  "worker",
  "store",
  "hook",
  "component"
]);

// True for key root files / entry points that should always rank first: README,
// the common manifests, schema files, and index/main entry points.
function isKeyRootFile(path: string): boolean {
  const name = (path.split("/").pop() || "").toLowerCase();
  return (
    /^readme(\.|$)/.test(name) ||
    name === "package.json" ||
    name === "pyproject.toml" ||
    name === "cargo.toml" ||
    name === "go.mod" ||
    /\.prisma$/.test(name) ||
    /^schema\.(graphql|gql|sql|prisma)$/.test(name) ||
    /^(index|main|__main__)\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|php)$/.test(name)
  );
}

// Importance tier for ingestion ordering (lower = more important):
//   0 — key root files / manifests / entry points / schemas
//   1 — high-value roles (PRIORITY_ROLES)
//   2 — everything else
function ingestPriorityTier(path: string): number {
  if (isKeyRootFile(path)) return 0;
  if (PRIORITY_ROLES.has(classifyFile(path))) return 1;
  return 2;
}

// Minimal shape the selector ranks on (path + byte size).
export interface IngestCandidate {
  path: string;
  size: number;
}

// Pure, deterministic selection of which candidate text files to ingest.
// Ranks by importance tier first, then prefers smaller files (more breadth per
// byte), then path/original order for stable ties, and finally applies the cap.
// No I/O — unit-testable in isolation.
export function selectFilesForIngest<T extends IngestCandidate>(files: T[], max: number): T[] {
  const cap = Math.max(0, Math.floor(max) || 0);
  if (cap === 0) return [];
  return files
    .map((file, index) => ({ file, index, tier: ingestPriorityTier(file.path) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.file.size - b.file.size ||
        (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0) ||
        a.index - b.index
    )
    .slice(0, cap)
    .map((entry) => entry.file);
}

// Total character budget for the file CONTENT fed into the architecture summary,
// keeping LLM cost bounded. ~18K chars sits in the suggested 16-20K range.
const SUMMARY_CHAR_BUDGET = 18_000;
// Per-file slice so one large README/lockfile can't consume the whole budget.
const SUMMARY_PER_FILE_CHARS = 6_000;
// Upper bound on how many distinct files contribute content to the summary.
const SUMMARY_MAX_FILES = 12;

// Build the "key file contents" block for the architecture summary: the
// highest-value fetched files (manifests, README, schema, top routes/services),
// each truncated and the whole thing bounded to SUMMARY_CHAR_BUDGET.
export function buildSummaryFileContents(
  files: { path: string; content: string | null }[],
  charBudget: number = SUMMARY_CHAR_BUDGET
): { included: string[]; text: string } {
  const withContent = files.filter(
    (f): f is { path: string; content: string } => typeof f.content === "string" && f.content.trim().length > 0
  );
  const ranked = [...withContent].sort(
    (a, b) =>
      ingestPriorityTier(a.path) - ingestPriorityTier(b.path) ||
      a.content.length - b.content.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );

  const parts: string[] = [];
  const included: string[] = [];
  let used = 0;
  for (const f of ranked) {
    if (included.length >= SUMMARY_MAX_FILES || used >= charBudget) break;
    const remaining = charBudget - used;
    const body = f.content.slice(0, Math.min(SUMMARY_PER_FILE_CHARS, remaining));
    if (!body.trim()) continue;
    const block = `FILE: ${f.path}\n${body}`;
    parts.push(block);
    included.push(f.path);
    used += block.length + 2;
  }
  return { included, text: parts.join("\n\n") };
}

export interface IngestResult {
  branch: string;
  filesIndexed: number;
  chunks: number;
  summary: string;
}

export async function ingestRepo(opts: {
  userId: string;
  projectId: string;
  repoUrl: string;
  token?: string;
  onProgress?: (done: number, total: number) => Promise<void>;
}): Promise<IngestResult> {
  const { owner, repo } = parseRepoUrl(opts.repoUrl);
  const repoInfo = await getRepoInfo(owner, repo, opts.token);
  const branch: string = repoInfo.default_branch || "main";

  const tree = await fetchTree(owner, repo, branch, opts.token);
  const candidates: { path: string; size: number }[] = tree
    .filter((n) => n.type === "blob" && isTextFile(n.path) && (n.size ?? 0) <= MAX_FILE_BYTES_LIMIT)
    .map((n) => ({ path: n.path, size: n.size ?? 0 }));
  // Prioritize high-value files (manifests, schemas, routes, services, ...) and
  // smaller files for breadth, then apply the configurable file cap.
  const blobs = selectFilesForIngest(candidates, MAX_FILES);

  // Remove any previously indexed chunks for this project (re-ingest is idempotent).
  const existing = await db
    .collection("knowledge_chunks")
    .where("userId", "==", opts.userId)
    .where("projectId", "==", opts.projectId)
    .limit(2000)
    .get();
  for (let i = 0; i < existing.docs.length; i += WRITE_BATCH) {
    const batch = db.batch();
    existing.docs.slice(i, i + WRITE_BATCH).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // Fetch files in parallel with a bounded concurrency to cut wall-clock time
  // while staying within GitHub rate limits.
  const total = blobs.length;
  let fetched = 0;
  const reportProgress = async () => {
    if (!opts.onProgress) return;
    try {
      await opts.onProgress(fetched, total);
    } catch (err) {
      log("warn", "ingest_progress_write_failed", { projectId: opts.projectId, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const files = await mapWithConcurrency(blobs, FETCH_CONCURRENCY, async (blob) => {
    // fetchRawFile defaults its truncation bound to the same env-configured
    // budget (GITHUB_MAX_FILE_BYTES) the tree size filter uses above, so the
    // fetched content matches what passed the filter.
    const content = await fetchRawFile(owner, repo, branch, blob.path, opts.token);
    fetched += 1;
    if (fetched % 10 === 0) await reportProgress();
    return { path: blob.path, content };
  });
  await reportProgress();

  // Build all chunks first, then embed/write in batches (fewer, larger calls).
  const pending: { path: string; text: string }[] = [];
  const indexedPaths: string[] = [];
  for (const f of files) {
    if (!f.content || !f.content.trim()) continue;
    const chunks = chunkText(`FILE: ${f.path}\n${f.content}`);
    if (!chunks.length) continue;
    indexedPaths.push(f.path);
    for (const text of chunks) pending.push({ path: f.path, text });
  }

  let savedChunks = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const part = pending.slice(i, i + EMBED_BATCH);
    const embeddings = await embeddingBatch(part.map((p) => p.text), opts.userId);
    for (let j = 0; j < part.length; j += WRITE_BATCH) {
      const slice = part.slice(j, j + WRITE_BATCH);
      const batch = db.batch();
      slice.forEach((p, idx) => {
        const ref = db.collection("knowledge_chunks").doc();
        batch.set(ref, {
          userId: opts.userId,
          scope: "project",
          projectId: opts.projectId,
          sourcePath: p.path,
          title: p.path,
          content: p.text,
          embedding: toVector(embeddings[j + idx]),
          chunkType: "code",
          confidence: 0.8,
          createdAt: serverTime()
        });
      });
      await batch.commit();
      savedChunks += slice.length;
    }
  }

  // Feed the LLM the actual content of the highest-value files (not just paths)
  // so the architecture summary is grounded in real code, within a cost bound.
  const keyContents = buildSummaryFileContents(files);
  const summaryInput = [
    `Репозиторий: ${owner}/${repo}`,
    `Ветка: ${branch}`,
    `Проиндексировано файлов: ${indexedPaths.length}`,
    "",
    "Файлы:",
    indexedPaths.join("\n").slice(0, 6000),
    "",
    "Содержимое ключевых файлов:",
    keyContents.text
  ].join("\n");
  const summary = await llm(
    "Ты principal software architect. По списку файлов и фрагментам кода кратко опиши: назначение проекта, стек, ключевые модули и архитектуру. Ответ на русском, структурно. Это только анализ для чтения — ничего не меняй.",
    summaryInput,
    0.2,
    opts.userId
  );

  return { branch, filesIndexed: indexedPaths.length, chunks: savedChunks, summary };
}
