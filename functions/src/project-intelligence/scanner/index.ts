import { parseRepoUrl, isTextFile, detectLanguage } from "../../pure";
import { mapWithConcurrency } from "../../concurrency";
import { MAX_FILE_BYTES, getRepoInfo, fetchTree, fetchRawFile } from "../../githubFetch";
import { log } from "../../log";
import type { FileRole, ScanResult, ScannedFile } from "../types";
import { isExcludedPath, isSecretFile } from "./exclude";
import { classifyFile } from "./classify";

// Bounds keep large repos affordable and within the worker's time/memory budget.
const MAX_INDEX_FILES = Number(process.env.SCAN_MAX_INDEX_FILES) || 4000;
const MAX_CONTENT_FILES = Number(process.env.SCAN_MAX_CONTENT_FILES) || 320;
const FETCH_CONCURRENCY = Number(process.env.GITHUB_FETCH_CONCURRENCY) || 8;

// Roles whose CONTENT is high-value for analysis and fetched first.
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

export interface ScanRepoOptions {
  repoUrl: string;
  token?: string;
  onProgress?: (done: number, total: number) => Promise<void>;
}

// Read-only repository scan: list the full git tree, classify every text file,
// then fetch the raw content of a prioritized, bounded subset for analysis.
// Secrets (.env and friends) are indexed by presence only — never fetched.
export async function scanRepo(opts: ScanRepoOptions): Promise<ScanResult> {
  const { owner, repo } = parseRepoUrl(opts.repoUrl);
  const repoInfo = await getRepoInfo(owner, repo, opts.token);
  const branch: string = repoInfo.default_branch || "main";

  const tree = await fetchTree(owner, repo, branch, opts.token);
  const totalTreeFiles = tree.filter((n) => n.type === "blob").length;

  // Build the index from text blobs that survive the exclude list and size cap.
  const indexed: ScannedFile[] = [];
  for (const node of tree) {
    if (node.type !== "blob") continue;
    if (isExcludedPath(node.path)) continue;
    if (!isTextFile(node.path)) continue;
    const size = node.size ?? 0;
    if (size > MAX_FILE_BYTES) continue;
    indexed.push({
      path: node.path,
      size,
      language: detectLanguage(node.path),
      role: classifyFile(node.path)
    });
    if (indexed.length >= MAX_INDEX_FILES) break;
  }

  // Decide which files get their content fetched: priority roles first, then
  // remaining source files, smallest-first so we cover more breadth per byte.
  const fetchable = indexed.filter((f) => !isSecretFile(f.path));
  const priority = fetchable.filter((f) => PRIORITY_ROLES.has(f.role));
  const rest = fetchable
    .filter((f) => !PRIORITY_ROLES.has(f.role))
    .sort((a, b) => a.size - b.size);
  const toFetch = [...priority, ...rest].slice(0, MAX_CONTENT_FILES);
  const truncated = toFetch.length < fetchable.length || indexed.length >= MAX_INDEX_FILES;

  const total = toFetch.length;
  let done = 0;
  const report = async () => {
    if (!opts.onProgress) return;
    try {
      await opts.onProgress(done, total);
    } catch (err) {
      log("warn", "scan_progress_write_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  };

  await mapWithConcurrency(toFetch, FETCH_CONCURRENCY, async (file) => {
    const content = await fetchRawFile(owner, repo, branch, file.path, opts.token);
    if (content) file.content = content;
    done += 1;
    if (done % 20 === 0) await report();
  });
  await report();

  return { branch, files: indexed, truncated, totalTreeFiles };
}
