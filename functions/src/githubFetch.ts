// Shared, read-only GitHub REST helpers. Extracted so both the knowledge
// ingestion (github.ts) and the project-intelligence scanner reuse one client.
//
// Every request here is an HTTP GET — the agent never writes to a user's repo.

import { AppError } from "./errors";

export const GITHUB_API = "https://api.github.com";

// Hard cap on a single file's fetched content (cost / memory guard).
export const MAX_FILE_BYTES = 100_000;

export function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "GHOST-Agent-Builder/1.0 (read-only)",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// GET a JSON endpoint, mapping GitHub HTTP errors to stable AppError codes.
export async function githubGetJson(path: string, token?: string): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, { method: "GET", headers: githubHeaders(token) });
  if (res.status === 404) {
    throw new AppError("github_repo_unavailable", 400, "Repository not found or no access (check token for private repos)");
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError("github_access_denied", 403, "GitHub access denied (invalid or missing token)");
  }
  if (!res.ok) throw new AppError("github_api_error", 502, `GitHub API error ${res.status}`);
  return res.json();
}

// Fetch a single file's raw text content (truncated to MAX_FILE_BYTES). Returns
// null when the file is unavailable so callers can skip it gracefully.
export async function fetchRawFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  token?: string
): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
    method: "GET",
    headers: { ...githubHeaders(token), Accept: "application/vnd.github.raw" }
  });
  if (!res.ok) return null;
  const text = await res.text();
  return text.slice(0, MAX_FILE_BYTES);
}

export interface RepoTreeNode {
  path: string;
  type: string;
  size?: number;
}

// Repo metadata (used for the default branch).
export async function getRepoInfo(owner: string, repo: string, token?: string): Promise<{ default_branch?: string }> {
  return githubGetJson(`/repos/${owner}/${repo}`, token);
}

// Recursive git tree for a branch — one API call returns the full file list.
export async function fetchTree(owner: string, repo: string, branch: string, token?: string): Promise<RepoTreeNode[]> {
  const tree = await githubGetJson(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token
  );
  return (tree.tree || []) as RepoTreeNode[];
}
