/**
 * Unit tests — verified build + auto-fix (Epic 4.2). No emulator: `./firebase`,
 * `./memory`, `./ai` and `./sandbox` are mocked so runVerifiedBuild can be driven
 * deterministically. Verifies the auto-fix branch: first verification FAILED →
 * one LLM repair pass (prompted with the failure logs) → second PASSED → the
 * retry artifacts are kept and `autofixed` is reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ai = vi.hoisted(() => ({ llm: vi.fn() }));
const sandbox = vi.hoisted(() => ({ verifyBuild: vi.fn() }));

vi.mock("../src/firebase", () => ({ db: { collection: vi.fn() }, admin: {} }));
vi.mock("../src/memory", () => ({ gatherContext: vi.fn(async () => []) }));
vi.mock("../src/ai", () => ({ llm: ai.llm }));
vi.mock("../src/sandbox", () => ({ verifyBuild: sandbox.verifyBuild }));

import { runVerifiedBuild } from "../src/build";

const baseOpts = {
  userId: "u1",
  projectId: "p1",
  project: { name: "Demo", description: "A demo project", stack: "typescript", summary: null, skillIds: [] as string[] },
  plan: null,
  instructions: "build it"
};

const FAILED = {
  status: "failed" as const,
  checks: [{ name: "tsc", ok: false, detail: "type error TS2322" }],
  summary: "Verification failed: tsc.",
  durationMs: 1,
  logs: [{ name: "tsc", exitCode: 1, stdout: "", stderr: "index.ts(1,7): error TS2322" }]
};
const PASSED = { status: "passed" as const, checks: [{ name: "tsc", ok: true }], summary: "ok", durationMs: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BUILD_AUTOFIX;
});
afterEach(() => {
  delete process.env.BUILD_AUTOFIX;
});

describe("runVerifiedBuild auto-fix (Epic 4.2)", () => {
  it("retries once on failure and keeps the passing retry", async () => {
    ai.llm
      .mockResolvedValueOnce(JSON.stringify({ files: [{ path: "index.ts", content: "const n: number = 'bad';" }], summary: "v1" }))
      .mockResolvedValueOnce(JSON.stringify({ files: [{ path: "index.ts", content: "export const n = 1;" }], summary: "v2" }));
    sandbox.verifyBuild.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(PASSED);

    const res = await runVerifiedBuild("run_1", baseOpts);

    expect(ai.llm).toHaveBeenCalledTimes(2);
    expect(sandbox.verifyBuild).toHaveBeenCalledTimes(2);
    expect(res.verification.status).toBe("passed");
    expect(res.autofixed).toBe(true);
    // The retry's artifacts (not the first attempt's) are kept.
    expect(res.files[0].content).toContain("export const n = 1;");

    // The repair prompt carried the failure logs + previous files.
    const repairUser = String(ai.llm.mock.calls[1][1]);
    expect(repairUser).toContain("НЕ ПРОШЛА ПРОВЕРКИ");
    expect(repairUser).toContain("type error TS2322");
    expect(repairUser).toContain("const n: number = 'bad';");
  });

  it("does NOT retry when the first verification passes", async () => {
    ai.llm.mockResolvedValueOnce(JSON.stringify({ files: [{ path: "index.ts", content: "export const x = 1;" }], summary: "v1" }));
    sandbox.verifyBuild.mockResolvedValueOnce(PASSED);

    const res = await runVerifiedBuild("run_2", baseOpts);
    expect(ai.llm).toHaveBeenCalledTimes(1);
    expect(sandbox.verifyBuild).toHaveBeenCalledTimes(1);
    expect(res.autofixed).toBe(false);
    expect(res.verification.status).toBe("passed");
  });

  it("keeps the first attempt when the retry is not strictly better", async () => {
    ai.llm
      .mockResolvedValueOnce(JSON.stringify({ files: [{ path: "a.ts", content: "first" }], summary: "v1" }))
      .mockResolvedValueOnce(JSON.stringify({ files: [{ path: "a.ts", content: "second" }], summary: "v2" }));
    sandbox.verifyBuild.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED);

    const res = await runVerifiedBuild("run_3", baseOpts);
    expect(ai.llm).toHaveBeenCalledTimes(2);
    expect(res.autofixed).toBe(false);
    expect(res.files[0].content).toContain("first");
  });

  it("does NOT retry when BUILD_AUTOFIX is disabled", async () => {
    process.env.BUILD_AUTOFIX = "0";
    ai.llm.mockResolvedValueOnce(JSON.stringify({ files: [{ path: "a.ts", content: "first" }], summary: "v1" }));
    sandbox.verifyBuild.mockResolvedValueOnce(FAILED);

    const res = await runVerifiedBuild("run_4", baseOpts);
    expect(ai.llm).toHaveBeenCalledTimes(1);
    expect(sandbox.verifyBuild).toHaveBeenCalledTimes(1);
    expect(res.autofixed).toBe(false);
    expect(res.verification.status).toBe("failed");
  });
});
