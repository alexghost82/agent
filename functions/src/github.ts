import { db } from "./firebase";
import { embeddingBatch, llm } from "./ai";
import { serverTime } from "./util";
import { chunkText, isTextFile, parseRepoUrl } from "./pure";
import { mapWithConcurrency } from "./concurrency";
import { log } from "./log";
import { AppError } from "./errors";

const GITHUB_API = "https://api.github.com";
const MAX_FILES = 200;
const MAX_FILE_BYTES = 100_000;
const FETCH_CONCURRENCY = Number(process.env.GITHUB_FETCH_CONCURRENCY) || 8;
const EMBED_BATCH = Number(process.env.EMBED_BATCH_SIZE) || 96;
const WRITE_BATCH = 400;

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "GHOST-Agent-Builder/1.0 (read-only)",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// All requests below are HTTP GET only. The agent never writes to the user's repo.
async function ghGet(path: string, token?: string): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, { method: "GET", headers: headers(token) });
  if (res.status === 404) {
    throw new AppError("github_repo_unavailable", 400, "Repository not found or no access (check token for private repos)");
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError("github_access_denied", 403, "GitHub access denied (invalid or missing token)");
  }
  if (!res.ok) throw new AppError("github_api_error", 502, `GitHub API error ${res.status}`);
  return res.json();
}

async function fetchRawFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  token?: string
): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
    method: "GET",
    headers: { ...headers(token), Accept: "application/vnd.github.raw" }
  });
  if (!res.ok) return null;
  const text = await res.text();
  return text.slice(0, MAX_FILE_BYTES);
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
  const repoInfo = await ghGet(`/repos/${owner}/${repo}`, opts.token);
  const branch: string = repoInfo.default_branch || "main";

  const tree = await ghGet(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, opts.token);
  const blobs: { path: string; size: number }[] = (tree.tree || [])
    .filter((n: any) => n.type === "blob" && isTextFile(n.path) && (n.size ?? 0) <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);

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
          embedding: embeddings[j + idx],
          chunkType: "code",
          confidence: 0.8,
          createdAt: serverTime()
        });
      });
      await batch.commit();
      savedChunks += slice.length;
    }
  }

  const summary = await llm(
    "Ты principal software architect. По списку файлов и фрагментам кода кратко опиши: назначение проекта, стек, ключевые модули и архитектуру. Ответ на русском, структурно. Это только анализ для чтения — ничего не меняй.",
    `Репозиторий: ${owner}/${repo}\nВетка: ${branch}\nПроиндексировано файлов: ${indexedPaths.length}\n\nФайлы:\n${indexedPaths.join("\n").slice(0, 12000)}`,
    0.2,
    opts.userId
  );

  return { branch, filesIndexed: indexedPaths.length, chunks: savedChunks, summary };
}
