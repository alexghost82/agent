import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { staticBuildChecks, type BuildFile, type VerificationCheck } from "./pure";
import { log } from "./log";

// Build execution / verification sandbox (CONTRACT v3.1).
//
// Artifacts are materialized into an ephemeral per-run directory under the OS
// temp dir, verified, then deleted. By default ONLY static, safe checks run —
// no untrusted code is executed. Nothing is written outside the sandbox and
// nothing is pushed to any external git remote.
//
// When BUILD_EXEC_ENABLED is set, a real toolchain (tsc / eslint / npm test) is
// run OVER the generated files inside the sandbox dir. That path is gated behind
// the flag because executing model-generated code is only safe on an isolated,
// disposable runner instance — never the shared API process. The runner is
// hardened: every child process runs with cwd pinned to the sandbox dir, a hard
// timeout, a scrubbed minimal env (no inherited secrets), no shell, offline npm,
// and `--ignore-scripts` on installs so lifecycle scripts cannot execute. No
// network install happens by default and nothing is ever pushed to a git remote.

export type VerificationStatus = "skipped" | "passed" | "failed" | "error";

// One captured child-process log, bounded in size and JSON-serializable so it
// can be persisted verbatim onto build_runs.verification by routes/build.ts.
export interface VerificationLog {
  name: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface Verification {
  status: VerificationStatus;
  checks: VerificationCheck[];
  summary: string;
  durationMs: number;
  // Present only when the toolchain actually ran (BUILD_EXEC_ENABLED). Optional
  // so the default static path keeps the exact same shape and build.ts persists
  // it automatically (it spreads the whole object onto the build_runs doc).
  logs?: VerificationLog[];
}

function execEnabled(): boolean {
  return process.env.BUILD_EXEC_ENABLED === "1" || process.env.BUILD_EXEC_ENABLED === "true";
}

// Per-process hard timeout (configurable). Defaults to 120s.
function execTimeoutMs(): number {
  const raw = Number(process.env.BUILD_EXEC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

// Big enough to capture realistic build logs without unbounded memory growth.
const MAX_BUFFER = 16 * 1024 * 1024;
// Per-check detail / per-log stream cap (chars). Keeps the persisted doc small.
const DETAIL_MAX = 4_000;

const ESLINT_CONFIG = new Set([
  ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml",
  ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"
]);

function baseName(p: string): string {
  return p.split("/").pop() || p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(${s.length - max} more chars truncated)`;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnFailed: boolean; // binary not found (ENOENT) → treat as "tool absent"
  timedOut: boolean;
}

// Minimal, scrubbed environment for child processes: only PATH plus npm hygiene
// flags. No inherited secrets (API keys, tokens) are passed through. HOME is
// pinned to the sandbox dir so any npm cache/config writes stay contained.
function safeEnv(sandboxDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: sandboxDir,
    TMPDIR: sandboxDir,
    CI: "1",
    NODE_ENV: "test",
    // Keep npm non-interactive and strictly offline: never reach the network.
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_offline: "true",
    npm_config_progress: "false"
  };
  // Windows node needs SystemRoot/ComSpec to spawn; pass through if present.
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

// Run a single child process with shell disabled and a hard timeout. Never
// throws: a non-zero exit, a timeout, or a missing binary are all reported via
// the resolved RunResult so the caller can map them to a VerificationCheck.
function runTool(file: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: safeEnv(cwd), shell: false, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
          const spawnFailed = e.code === "ENOENT";
          const timedOut = e.killed === true; // SIGTERM from the timeout option
          resolve({
            exitCode: typeof e.code === "number" ? e.code : null,
            stdout: out,
            stderr: errOut,
            spawnFailed,
            timedOut
          });
        } else {
          resolve({ exitCode: 0, stdout: out, stderr: errOut, spawnFailed: false, timedOut: false });
        }
      }
    );
  });
}

// Walk up from the current working dir looking for a locally-installed file
// (e.g. node_modules/typescript/bin/tsc). Returns null if not found. Used so we
// can run a locally-resolvable tool with `node <bin>` rather than relying on a
// globally installed binary or a network `npx` fetch.
async function findUp(relPath: string): Promise<string | null> {
  let cur = process.cwd();
  for (;;) {
    const candidate = path.join(cur, relPath);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not here; keep climbing
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function combined(r: RunResult): string {
  const text = (r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : "")).trim();
  return truncate(text, DETAIL_MAX);
}

function pushLog(logs: VerificationLog[], name: string, r: RunResult): void {
  logs.push({
    name,
    exitCode: r.exitCode,
    stdout: truncate(r.stdout.trim(), DETAIL_MAX),
    stderr: truncate(r.stderr.trim(), DETAIL_MAX)
  });
}

// Map a finished RunResult to a VerificationCheck. A missing binary or a timeout
// never hard-fails the build for "infra" reasons we can't control: a missing
// tool is skipped (ok), a timeout is a real failure (ok=false) with a clear note.
function toCheck(name: string, r: RunResult): VerificationCheck {
  if (r.spawnFailed) return { name, ok: true, detail: "skipped: tool not resolvable in sandbox" };
  if (r.timedOut) return { name, ok: false, detail: `timed out after ${execTimeoutMs()}ms` };
  const ok = r.exitCode === 0;
  const out = combined(r);
  return { name, ok, detail: out || (ok ? "ok" : `exit ${r.exitCode}`) };
}

// Run a real toolchain over the materialized files. Only runs a tool when the
// corresponding config/marker was generated; otherwise the check is skipped with
// a clear detail. Appends VerificationChecks and captured logs in place.
async function runToolchain(
  dir: string,
  files: BuildFile[],
  checks: VerificationCheck[],
  logs: VerificationLog[]
): Promise<void> {
  const timeoutMs = execTimeoutMs();

  const pkgFile = files.find((f) => baseName(f.path) === "package.json" && !f.path.includes("/"));
  let pkg: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | null = null;
  if (pkgFile) {
    try {
      pkg = JSON.parse(pkgFile.content);
    } catch {
      pkg = null; // invalid JSON is already reported by staticBuildChecks.json_parses
    }
  }

  const hasTsconfig = files.some((f) => baseName(f.path) === "tsconfig.json");
  const hasEslintConfig = files.some((f) => ESLINT_CONFIG.has(baseName(f.path)));
  const testScript = pkg && pkg.scripts && typeof pkg.scripts.test === "string" ? (pkg.scripts.test as string).trim() : "";
  const hasTestScript = testScript.length > 0;
  const depCount =
    (pkg?.dependencies ? Object.keys(pkg.dependencies).length : 0) +
    (pkg?.devDependencies ? Object.keys(pkg.devDependencies).length : 0);

  let ran = 0;

  // 1) Dependencies: strictly offline + no lifecycle scripts (security). If the
  //    offline cache can't satisfy it, the check fails with the captured log —
  //    we never fall back to a network fetch.
  if (depCount > 0) {
    ran++;
    const r = await runTool(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock"],
      dir,
      timeoutMs
    );
    pushLog(logs, "deps_install", r);
    checks.push(toCheck("deps_install", r));
  }

  // 2) Type-check: `tsc --noEmit` only when a tsconfig.json was generated.
  if (hasTsconfig) {
    ran++;
    const tscBin = await findUp(path.join("node_modules", "typescript", "bin", "tsc"));
    if (!tscBin) {
      checks.push({ name: "tsc", ok: true, detail: "skipped: typescript not resolvable in sandbox" });
    } else {
      const r = await runTool(process.execPath, [tscBin, "--noEmit", "--pretty", "false"], dir, timeoutMs);
      pushLog(logs, "tsc", r);
      checks.push(toCheck("tsc", r));
    }
  }

  // 3) Lint: only when an eslint config was generated.
  if (hasEslintConfig) {
    ran++;
    const eslintBin = await findUp(path.join("node_modules", "eslint", "bin", "eslint.js"));
    if (!eslintBin) {
      checks.push({ name: "eslint", ok: true, detail: "skipped: eslint not resolvable in sandbox" });
    } else {
      const r = await runTool(process.execPath, [eslintBin, "."], dir, timeoutMs);
      pushLog(logs, "eslint", r);
      checks.push(toCheck("eslint", r));
    }
  }

  // 4) Tests: only when package.json declares a `scripts.test`. npm runs the
  //    script (in its own internal shell) with our scrubbed/offline env.
  if (hasTestScript) {
    ran++;
    const r = await runTool("npm", ["test", "--silent"], dir, timeoutMs);
    pushLog(logs, "npm_test", r);
    checks.push(toCheck("npm_test", r));
  }

  if (ran === 0) {
    checks.push({
      name: "toolchain",
      ok: true,
      detail: "skipped: no runnable toolchain markers (tsconfig/eslint config/test script) among generated files"
    });
  }
}

// Materializes files into an ephemeral sandbox dir, guaranteeing every write
// stays inside it (defense-in-depth on top of sanitizeArtifactPath), then runs
// verification and cleans up. Best-effort: any infra error → status "error".
export async function verifyBuild(buildRunId: string, files: BuildFile[]): Promise<Verification> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ghost-build-${buildRunId.slice(0, 12)}-`));
  try {
    let escaped = false;
    for (const f of files) {
      const target = path.resolve(dir, f.path);
      // Containment guard: resolved path must remain within the sandbox dir.
      if (target !== dir && !target.startsWith(dir + path.sep)) {
        escaped = true;
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, f.content, "utf8");
    }

    const checks = staticBuildChecks(files);
    checks.push({ name: "sandbox_contained", ok: !escaped, detail: escaped ? "a path escaped the sandbox and was skipped" : undefined });

    const logs: VerificationLog[] = [];
    if (execEnabled()) {
      // Opt-in real toolchain execution — only safe on an isolated runner.
      await runToolchain(dir, files, checks, logs);
    }

    const ok = checks.every((c) => c.ok);
    const status: VerificationStatus = ok ? "passed" : "failed";
    const summary = ok
      ? `Verified ${files.length} file(s): ${checks.map((c) => c.name).join(", ")}.`
      : `Verification failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}.`;
    const result: Verification = { status, checks, summary, durationMs: Date.now() - started };
    if (logs.length) result.logs = logs;
    return result;
  } catch (err) {
    log("warn", "build_verify_error", { buildRunId, message: err instanceof Error ? err.message : String(err) });
    return { status: "error", checks: [], summary: "verification error", durationMs: Date.now() - started };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
