/**
 * Standalone build-verification harness (Epic 4 / CONTRACT v3.1).
 *
 * Drives the SAME real build-verification code path used in production
 * (`verifyBuild` from src/sandbox) over a fixture project on disk. By default
 * the toolchain (deps/tsc/eslint/npm test) only runs when BUILD_EXEC_ENABLED is
 * set — this harness is meant to be run on an isolated, disposable runner where
 * that flag is on (see .github/workflows/build-verification.yml).
 *
 * Run locally (real toolchain):
 *   BUILD_EXEC_ENABLED=1 npx tsx scripts/verify-build.ts [fixtureDir]
 * With no fixtureDir a tiny sample project is generated in a temp dir, verified,
 * and cleaned up. The process exits non-zero if verification does not pass, so
 * it is usable as a CI gate.
 *
 * This module also exports its building blocks so the gated integration test
 * (test/integration-real/build_exec.test.ts) can reuse the exact same flow.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyBuild, type Verification } from "../src/sandbox";
import { detectLanguage, type BuildFile } from "../src/pure";

const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".next"]);

// Read a fixture project directory recursively into the in-memory BuildFile[]
// shape the verifier consumes. Paths are normalized to forward-slash relatives.
export async function readFixtureDir(dir: string): Promise<BuildFile[]> {
  const out: BuildFile[] = [];
  async function walk(cur: string): Promise<void> {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, abs).split(path.sep).join("/");
        const content = await fs.readFile(abs, "utf8");
        out.push({ path: rel, content, language: detectLanguage(rel), bytes: Buffer.byteLength(content, "utf8") });
      }
    }
  }
  await walk(dir);
  return out;
}

// Verify a fixture project directory through the production verifier.
export async function verifyFixtureDir(dir: string, buildRunId = `verify-${Date.now()}`): Promise<Verification> {
  const files = await readFixtureDir(dir);
  return verifyBuild(buildRunId, files);
}

// Materialize a tiny, hermetic, network-free fixture project into a fresh temp
// dir. Coherent enough to reach a verified (passed) state: a manifest entry, a
// valid strict-TypeScript file, and a trivial passing test script. Caller owns
// cleanup of the returned directory.
export async function writeSampleFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghost-fixture-"));
  const pkg = {
    name: "sample-verified-build",
    version: "1.0.0",
    private: true,
    scripts: { test: 'node -e "process.exit(0)"' }
  };
  const tsconfig = {
    compilerOptions: { strict: true, noEmit: true, target: "es2020", module: "commonjs" },
    include: ["index.ts"]
  };
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "index.ts"), "export const answer: number = 42;\n", "utf8");
  return dir;
}

function execEnabled(): boolean {
  return process.env.BUILD_EXEC_ENABLED === "1" || process.env.BUILD_EXEC_ENABLED === "true";
}

async function main(): Promise<void> {
  const argDir = process.argv[2] && process.argv[2].trim() ? process.argv[2].trim() : "";
  if (!execEnabled()) {
    console.warn(
      "[verify-build] BUILD_EXEC_ENABLED is not set — only static checks will run. " +
      "Set BUILD_EXEC_ENABLED=1 (on an isolated runner) for real toolchain verification."
    );
  }

  let dir = argDir;
  let cleanup = false;
  if (!dir) {
    dir = await writeSampleFixture();
    cleanup = true;
    console.log(`[verify-build] no fixture path given; using generated sample fixture at ${dir}`);
  } else {
    console.log(`[verify-build] verifying fixture project at ${dir}`);
  }

  try {
    const verification = await verifyFixtureDir(dir, `verify-cli-${Date.now()}`);
    console.log(JSON.stringify(verification, null, 2));
    if (verification.status !== "passed") {
      console.error(`[verify-build] FAILED — verification status=${verification.status}: ${verification.summary}`);
      process.exitCode = 1;
    } else {
      console.log(`[verify-build] OK — ${verification.summary}`);
    }
  } finally {
    if (cleanup && dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Run main() only when executed directly (tsx/node), not when imported by a test.
const invokedDirectly = process.argv[1] ? /verify-build\.(ts|js|mjs|cjs)$/.test(process.argv[1]) : false;
if (invokedDirectly) {
  void main();
}
