import { db } from "./firebase";
import { embedding, llm } from "./ai";
import { serverTime } from "./util";
import { chunkText, isTextFile, parseRepoUrl } from "./pure";

const GITHUB_API = "https://api.github.com";
const MAX_FILES = 200;
const MAX_FILE_BYTES = 100_000;

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
  if (res.status === 404) throw new Error("Repository not found or no access (check token for private repos)");
  if (res.status === 401 || res.status === 403) throw new Error("GitHub access denied (invalid or missing token)");
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
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
  for (let i = 0; i < existing.docs.length; i += 400) {
    const batch = db.batch();
    existing.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  const indexedPaths: string[] = [];
  let savedChunks = 0;

  for (const blob of blobs) {
    const content = await fetchRawFile(owner, repo, branch, blob.path, opts.token);
    if (!content || !content.trim()) continue;
    const chunks = chunkText(`FILE: ${blob.path}\n${content}`);
    for (let i = 0; i < chunks.length; i += 20) {
      const part = chunks.slice(i, i + 20);
      const embeddings = await Promise.all(part.map((c) => embedding(c)));
      const batch = db.batch();
      part.forEach((c, idx) => {
        const ref = db.collection("knowledge_chunks").doc();
        batch.set(ref, {
          userId: opts.userId,
          scope: "project",
          projectId: opts.projectId,
          sourcePath: blob.path,
          title: blob.path,
          content: c,
          embedding: embeddings[idx],
          chunkType: "code",
          confidence: 0.8,
          createdAt: serverTime()
        });
      });
      await batch.commit();
      savedChunks += part.length;
    }
    indexedPaths.push(blob.path);
  }

  const summary = await llm(
    "Ты principal software architect. По списку файлов и фрагментам кода кратко опиши: назначение проекта, стек, ключевые модули и архитектуру. Ответ на русском, структурно. Это только анализ для чтения — ничего не меняй.",
    `Репозиторий: ${owner}/${repo}\nВетка: ${branch}\nПроиндексировано файлов: ${indexedPaths.length}\n\nФайлы:\n${indexedPaths.join("\n").slice(0, 12000)}`
  );

  return { branch, filesIndexed: indexedPaths.length, chunks: savedChunks, summary };
}
