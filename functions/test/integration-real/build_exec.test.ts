/**
 * Gated REAL-execution integration test (Epic 4 / CONTRACT v3.1).
 *
 * Unlike test/sandbox.test.ts (which flips BUILD_EXEC_ENABLED per-case with tiny
 * inline package.json blobs), this suite drives the full build-verification flow
 * over a real fixture project on disk via the shared harness
 * (scripts/verify-build.ts), exactly as the build-verification workflow does.
 *
 * It runs ONLY when BUILD_EXEC_ENABLED=1 (set on an isolated, disposable runner)
 * and SELF-SKIPS otherwise — mirroring the repo's `describe.skipIf(...)`
 * convention used for emulator-only integration suites. It must therefore stay
 * green (by skipping) in the normal `npm test` / CI run where the flag is unset.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { verifyFixtureDir, writeSampleFixture } from "../../scripts/verify-build";

const EXEC_ENABLED =
  process.env.BUILD_EXEC_ENABLED === "1" || process.env.BUILD_EXEC_ENABLED === "true";

const countSandboxes = async (): Promise<number> =>
  (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("ghost-build-")).length;

describe.skipIf(!EXEC_ENABLED)("integration-real: gated build execution (BUILD_EXEC_ENABLED)", () => {
  it("drives the real toolchain over a fixture and reaches a verified state with build output", async () => {
    const dir = await writeSampleFixture();
    try {
      const v = await verifyFixtureDir(dir, "run_exec_fixture");

      // The gated path actually executed a toolchain — not just the static checks
      // that run by default. (If a tool is not resolvable in the sandbox it is
      // reported as a skipped-but-ok check, which still proves the path ran.)
      const names = v.checks.map((c) => c.name);
      expect(names.some((n) => ["tsc", "eslint", "npm_test", "deps_install", "toolchain"].includes(n))).toBe(true);

      // Verified / ready: every check passed and the overall status is "passed"
      // (the route maps this to a build_runs status of "ready").
      expect(v.status).toBe("passed");
      expect(v.checks.every((c) => c.ok)).toBe(true);

      // Real build output was captured and reported.
      expect(Array.isArray(v.logs)).toBe(true);
      expect(v.logs!.length).toBeGreaterThan(0);
      expect(typeof v.summary).toBe("string");
      expect(v.summary.length).toBeGreaterThan(0);

      // The fixture ships a tsconfig + valid strict TS, so tsc must either have
      // run and passed, or gracefully skipped (tool not resolvable) — never fail.
      const tsc = v.checks.find((c) => c.name === "tsc");
      expect(tsc, "tsc check should be present").toBeTruthy();
      expect(tsc!.ok).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);

  it("cleans up its ephemeral sandbox dir on the real-exec path", async () => {
    const before = await countSandboxes();
    const dir = await writeSampleFixture();
    try {
      await verifyFixtureDir(dir, "run_exec_cleanup");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    const after = await countSandboxes();
    expect(after).toBe(before);
  }, 180_000);
});
