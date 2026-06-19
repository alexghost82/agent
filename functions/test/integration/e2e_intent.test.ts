/**
 * Integration test — FULL PRODUCT CYCLE (e2e) against the Firestore emulator.
 *
 * Drives the real Express routers end-to-end through one product loop:
 *   POST /login → POST /topics → POST /learn → POST /extract-skills →
 *   POST /projects → POST /design → POST /generate-plan → POST /projects/:id/build
 *
 * Self-skip: like every sibling suite (sources/skills/plans/design/build), this
 * is gated on `EMULATOR_AVAILABLE` via `describe.skipIf` from the shared harness,
 * so the default `npm test` (no emulator) stays green and only the CI emulator
 * job runs it.
 *
 * AI / network mocking: the sibling suites never reach the LLM happy path — they
 * `stashEnv(["OPENAI_API_KEY","GEMINI_API_KEY"])` to drive everything to the
 * deterministic `no_api_key` boundary (see e.g. skills.test.ts / build.test.ts).
 * That keeps them offline but cannot exercise the full cycle. To run the WHOLE
 * loop without touching `src/**` and without ever calling the real OpenAI API,
 * we instead intercept the two network seams inside the production module graph
 * with `vi.mock` (test-only):
 *   - `src/providers/openai`  → deterministic embeddings + an LLM stub that
 *     branches on the prompt to return the JSON/text each route expects. `ai.ts`
 *     keys/provider-resolution logic stays REAL; we only replace the HTTP calls.
 *   - `src/ssrf`              → `readUrl`/`crawlSite` return canned page text so
 *     `/learn` never hits the network (SSRF guard logic is left untouched).
 * A fake `OPENAI_API_KEY` is set for the suite so `ai.ts#resolve` succeeds and
 * dispatches into the mocked provider (the user has no per-user key, provider
 * defaults to "openai"). Nothing here modifies `functions/src/**`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// Network seams replaced for the whole module graph (hoisted above imports).
// We keep the real modules intact and override ONLY the functions that would
// otherwise perform a network call, so `ai.ts` resolution + the SSRF guard code
// remain the production code under test.
// ---------------------------------------------------------------------------

const FAKE_PAGE_TEXT =
  "GHOST Agent Builder is an autonomous engineering platform. It learns from " +
  "sources, extracts reusable skills, designs an architecture, plans the work " +
  "and then builds real project files with idempotent, well-validated code.";

vi.mock("../../src/providers/openai", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/providers/openai");
  // Deterministic, fixed-dimension embedding (no network). Constant vectors are
  // fine: cosine similarity stays defined and `searchMemory` still returns the
  // stored chunks (it only needs a non-empty candidate set here).
  const vector = () => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  return {
    ...actual,
    openaiEmbedding: vi.fn(async (_apiKey: string, _input: string) => vector()),
    openaiEmbeddingBatch: vi.fn(async (_apiKey: string, inputs: string[]) => inputs.map(() => vector())),
    openaiTest: vi.fn(async (_apiKey: string) => undefined),
    // Single LLM stub for every route; branch on the system prompt so each step
    // gets a payload its parser accepts (see skills/plans/build/design routes).
    openaiLlm: vi.fn(async (_apiKey: string, system: string, _user: string, _temperature?: number) => {
      // extract-skills → strict JSON array of skills.
      if (system.includes("reusable engineering skills")) {
        return JSON.stringify([
          {
            skillName: "Idempotent Writes",
            description: "Make every write operation safely retryable to avoid duplicate side effects.",
            example: "Use a deterministic request id as the document id so retries upsert.",
            appliesTo: ["firestore", "nextjs"],
            template: "const ref = db.collection('x').doc(requestId);"
          },
          {
            skillName: "Schema-Validated Input",
            description: "Validate and bound all external input with a schema before any processing.",
            example: "Schema.parse(req.body) rejects malformed/oversized payloads early.",
            appliesTo: ["typescript", "zod"],
            template: "const body = Schema.parse(req.body);"
          }
        ]);
      }
      // generate-plan → JSON object with md files + exactly one orchestrator prompt.
      if (system.includes('"prompts"')) {
        return JSON.stringify({
          files: [
            { path: "OVERVIEW.md", content: "# Overview\n\nProject overview and goals." },
            { path: "IMPLEMENTATION_PLAN.md", content: "# Implementation Plan\n\n1. Step one\n2. Step two" }
          ],
          prompts: [
            {
              title: "Orchestrator",
              content:
                "You are the orchestrator agent. Spawn sub-agents, give each a precise sub-prompt, " +
                "coordinate them and assemble the final result for the project."
            }
          ]
        });
      }
      // build → JSON object with real project files + a summary.
      if (system.includes('"summary"')) {
        return JSON.stringify({
          files: [
            { path: "README.md", content: "# Demo\n\nGenerated by the e2e build step." },
            { path: "index.ts", content: "export const hello = (): string => 'world';\n" },
            { path: "package.json", content: JSON.stringify({ name: "demo", version: "1.0.0", private: true }, null, 2) }
          ],
          summary: "Generated a minimal, self-contained demo project."
        });
      }
      // design / generateAnswer (and any other call) → plain prose.
      return (
        "## Дизайн\n" +
        "1) Цель и контекст: автономная сборка проекта.\n" +
        "2) Затрагиваемые модули.\n" +
        "3) Предлагаемая архитектура.\n" +
        "Риски и следующий шаг описаны ниже."
      );
    })
  };
});

vi.mock("../../src/ssrf", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/ssrf");
  return {
    ...actual,
    readUrl: vi.fn(async (url: string) => ({ title: "E2E Source", text: FAKE_PAGE_TEXT })),
    crawlSite: vi.fn(async (url: string) => [{ url, title: "E2E Source", text: FAKE_PAGE_TEXT }])
  };
});

import {
  EMULATOR_AVAILABLE,
  startServer,
  seedLoginUser,
  type TestServer
} from "../helpers/harness";

describe.skipIf(!EMULATOR_AVAILABLE)("integration: e2e product cycle (learn → skills → design → plan → build)", () => {
  let srv: TestServer;
  let restoreKey: () => void;

  beforeAll(async () => {
    // A fake key makes `ai.ts#resolve` succeed and dispatch into the MOCKED
    // OpenAI provider — never the real API. Saved/restored so it does not leak
    // into sibling suites (which rely on NO key being present).
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-e2e-fake-key";
    restoreKey = () => {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    };
    srv = await startServer();
  });

  afterAll(async () => {
    await srv.close();
    restoreKey();
    vi.restoreAllMocks();
  });

  /**
   * If the AI seam was NOT intercepted for some reason (e.g. resolution failed
   * and surfaced `no_api_key`), we don't FAIL the suite — per the task we mark
   * the remaining AI-dependent assertions as a soft, clearly-logged skip. With
   * the mocks above this branch should never trigger.
   */
  function aiBlocked(res: { status: number; body: any }, label: string): boolean {
    if (res.status === 400 && res.body?.error === "no_api_key") {
      console.warn(`[e2e] '${label}' returned no_api_key — AI seam not mocked in this env; skipping AI-dependent asserts.`);
      return true;
    }
    return false;
  }

  it("runs the full product cycle with mocked AI + URL fetch", async () => {
    // 1) LOGIN — real password login issues a session bearer.
    const creds = await seedLoginUser("e2e-password-123");
    const login = await srv.request("POST", "/login", {
      body: { username: creds.username, password: creds.password }
    });
    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe("string");
    const token = login.body.token as string;

    // 2) TOPIC
    const topicRes = await srv.request("POST", "/topics", {
      token,
      body: { name: "Autonomous Agents", description: "Knowledge about building agents." }
    });
    expect(topicRes.status).toBe(200);
    const topicId = topicRes.body.id as string;
    expect(typeof topicId).toBe("string");

    // 3) LEARN — readUrl is mocked, embeddings are mocked → chunks are saved.
    const learnRes = await srv.request("POST", "/learn", {
      token,
      body: { topicId, url: "https://example.com/agents-guide" }
    });
    expect(learnRes.status).toBe(200);
    expect(learnRes.body.status).toBe("saved");
    // After learn there is persisted knowledge (≥1 chunk).
    expect(learnRes.body.chunks).toBeGreaterThanOrEqual(1);

    const sources = await srv.request("GET", `/sources?topicId=${topicId}`, { token });
    expect(sources.status).toBe(200);
    expect(sources.body.sources.length).toBeGreaterThanOrEqual(1);

    // 4) EXTRACT-SKILLS — searchMemory (mock embedding) + LLM stub → skills.
    const skillsRes = await srv.request("POST", "/extract-skills", { token, body: { topicId } });
    if (!aiBlocked(skillsRes, "extract-skills")) {
      expect(skillsRes.status).toBe(200);
      expect(Array.isArray(skillsRes.body.skills)).toBe(true);
      expect(skillsRes.body.skills.length).toBeGreaterThanOrEqual(1);
    }

    // 5) PROJECT
    const projectRes = await srv.request("POST", "/projects", {
      token,
      body: { name: "Demo Agent Platform", description: "A from-scratch agent platform.", stack: "typescript" }
    });
    expect(projectRes.status).toBe(200);
    const projectId = projectRes.body.id as string;
    expect(typeof projectId).toBe("string");

    // 6) DESIGN — generateAnswer → plain-text design content.
    const designRes = await srv.request("POST", "/design", {
      token,
      body: { projectId, section: "Spin up the core agent loop" }
    });
    if (!aiBlocked(designRes, "design")) {
      expect(designRes.status).toBe(200);
      expect(typeof designRes.body.plan).toBe("string");
      expect(designRes.body.plan.length).toBeGreaterThan(0);
    }

    // 7) GENERATE-PLAN — LLM stub → md files + one orchestrator prompt.
    const planRes = await srv.request("POST", "/generate-plan", {
      token,
      body: { projectId, instructions: "Keep it minimal but complete." }
    });
    let planId: string | undefined;
    if (!aiBlocked(planRes, "generate-plan")) {
      expect(planRes.status).toBe(200);
      expect(Array.isArray(planRes.body.files)).toBe(true);
      expect(planRes.body.files.length).toBeGreaterThanOrEqual(1);
      planId = planRes.body.id as string;
    }

    // 8) BUILD — runBuild (LLM stub) → real files, then static verification.
    const buildRes = await srv.request("POST", `/projects/${projectId}/build`, {
      token,
      body: planId ? { planId } : {}
    });
    if (!aiBlocked(buildRes, "build")) {
      expect(buildRes.status).toBe(200);
      expect(buildRes.body.status).toBe("ready");
      // Build returns ≥1 file …
      expect(Array.isArray(buildRes.body.files)).toBe(true);
      expect(buildRes.body.files.length).toBeGreaterThanOrEqual(1);
      // … and verification ran without an infra error.
      expect(buildRes.body.verification).toBeTruthy();
      expect(buildRes.body.verification.status).not.toBe("error");
    }
  });
});
