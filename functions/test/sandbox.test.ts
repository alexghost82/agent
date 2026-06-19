/**
 * Unit tests — build sandbox (CONTRACT v3.1). Exercises real fs materialization
 * into an ephemeral temp dir (no Firestore/emulator needed), the containment
 * guard, and verification status. Also exercises the opt-in BUILD_EXEC_ENABLED
 * toolchain runner with hermetic, network-free fixtures. Cleans up after itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { verifyBuild } from "../src/sandbox";
import type { BuildFile } from "../src/pure";

const mk = (path: string, content: string): BuildFile => ({ path, content, language: null, bytes: Buffer.byteLength(content) });

const countSandboxes = async () =>
  (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("ghost-build-")).length;

describe("verifyBuild (static, default)", () => {
  it("passes a coherent build and leaves no temp dir behind", async () => {
    const before = await countSandboxes();
    const v = await verifyBuild("run_abc123", [mk("package.json", '{"name":"demo"}'), mk("src/index.ts", "export const x = 1;")]);
    expect(v.status).toBe("passed");
    expect(v.checks.find((c) => c.name === "sandbox_contained")!.ok).toBe(true);
    expect(typeof v.durationMs).toBe("number");
    const after = await countSandboxes();
    expect(after).toBe(before); // sandbox cleaned up
  });

  it("fails verification when JSON is invalid", async () => {
    const v = await verifyBuild("run_bad", [mk("package.json", "{nope")]);
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.name === "json_parses")!.ok).toBe(false);
  });

  it("reports passed with no files? (files_present fails -> failed)", async () => {
    const v = await verifyBuild("run_empty", []);
    expect(v.status).toBe("failed");
  });
});

describe("verifyBuild (toolchain, BUILD_EXEC_ENABLED)", () => {
  let prevEnabled: string | undefined;
  let prevTimeout: string | undefined;

  beforeEach(() => {
    prevEnabled = process.env.BUILD_EXEC_ENABLED;
    prevTimeout = process.env.BUILD_EXEC_TIMEOUT_MS;
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.BUILD_EXEC_ENABLED;
    else process.env.BUILD_EXEC_ENABLED = prevEnabled;
    if (prevTimeout === undefined) delete process.env.BUILD_EXEC_TIMEOUT_MS;
    else process.env.BUILD_EXEC_TIMEOUT_MS = prevTimeout;
  });

  it("does NOT execute anything when the flag is unset", async () => {
    delete process.env.BUILD_EXEC_ENABLED;
    const pkg = JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: 'node -e "process.exit(1)"' } });
    const v = await verifyBuild("run_noexec", [mk("package.json", pkg)]);
    // A failing test script is present, but it must never run by default.
    expect(v.status).toBe("passed");
    expect(v.checks.some((c) => ["npm_test", "tsc", "eslint", "deps_install", "toolchain"].includes(c.name))).toBe(false);
    expect(v.logs).toBeUndefined();
  }, 30_000);

  it("runs a passing test script -> ok check + overall passed", async () => {
    process.env.BUILD_EXEC_ENABLED = "1";
    const pkg = JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } });
    const v = await verifyBuild("run_pass", [mk("package.json", pkg)]);
    const test = v.checks.find((c) => c.name === "npm_test");
    expect(test, "npm_test check should be present").toBeTruthy();
    expect(test!.ok).toBe(true);
    expect(v.status).toBe("passed");
    expect(Array.isArray(v.logs)).toBe(true);
    expect(v.logs!.some((l) => l.name === "npm_test")).toBe(true);
  }, 30_000);

  it("runs a failing test script -> failed check + overall failed + captured log", async () => {
    process.env.BUILD_EXEC_ENABLED = "1";
    const pkg = JSON.stringify({
      name: "demo",
      version: "1.0.0",
      scripts: { test: 'node -e "console.error(\'boom-marker\'); process.exit(1)"' }
    });
    const v = await verifyBuild("run_fail", [mk("package.json", pkg)]);
    const test = v.checks.find((c) => c.name === "npm_test");
    expect(test!.ok).toBe(false);
    expect(v.status).toBe("failed");
    const logLine = v.logs!.find((l) => l.name === "npm_test")!;
    expect(logLine.exitCode === null || logLine.exitCode !== 0).toBe(true);
  }, 30_000);

  it("cleans up the temp dir even on the exec path", async () => {
    process.env.BUILD_EXEC_ENABLED = "1";
    const before = await countSandboxes();
    const pkg = JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } });
    await verifyBuild("run_cleanup", [mk("package.json", pkg)]);
    const after = await countSandboxes();
    expect(after).toBe(before);
  }, 30_000);

  it("handles a tsconfig: type-checks if tsc resolves, else skips gracefully", async () => {
    process.env.BUILD_EXEC_ENABLED = "1";
    // Deliberately broken TypeScript: a string assigned to a number.
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true } });
    const v = await verifyBuild("run_tsc", [
      mk("tsconfig.json", tsconfig),
      mk("index.ts", "const n: number = 'not a number';\nexport { n };\n")
    ]);
    const tsc = v.checks.find((c) => c.name === "tsc");
    expect(tsc, "tsc check should be present").toBeTruthy();
    if (/skipped/i.test(tsc!.detail ?? "")) {
      // Tool not resolvable in the sandbox -> graceful skip (ok=true).
      expect(tsc!.ok).toBe(true);
    } else {
      // Tool ran -> it must have caught the type error.
      expect(tsc!.ok).toBe(false);
      expect(v.status).toBe("failed");
    }
  }, 60_000);

  it("skips toolchain with a clear note when no runnable markers exist", async () => {
    process.env.BUILD_EXEC_ENABLED = "1";
    const v = await verifyBuild("run_nomarkers", [mk("README.md", "# hello")]);
    const tc = v.checks.find((c) => c.name === "toolchain");
    expect(tc).toBeTruthy();
    expect(tc!.ok).toBe(true);
    expect(v.status).toBe("passed");
  }, 30_000);
});
