/**
 * Unit tests — ask + design routers HAPPY PATH (no emulator, no AI key).
 *
 * The emulator integration suites only reach the `no_api_key` boundary because
 * they exercise the REAL ai/memory modules. Here we mount the real routers on a
 * bare Express app with a stub auth middleware and mock the AI/memory/persistence
 * collaborators, so the success branch (generate -> persist -> respond) is
 * actually executed and asserted.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";

const ai = vi.hoisted(() => ({ generateAnswer: vi.fn(async () => "CANNED ANSWER") }));
const memory = vi.hoisted(() => ({
  searchMemory: vi.fn(async () => [{ id: "c1", content: "ctx", score: 0.9 }]),
  gatherContext: vi.fn(async () => [{ id: "c1", content: "ctx", score: 0.9 }])
}));
const learn = vi.hoisted(() => ({ recordOutcome: vi.fn(async () => ({ saved: true })) }));
const usage = vi.hoisted(() => ({ recordUsage: vi.fn(async () => {}) }));
const stats = vi.hoisted(() => ({ bumpCounter: vi.fn(async () => {}) }));
const util = vi.hoisted(() => ({ serverTime: () => "TS", logEvent: vi.fn(async () => {}) }));

// Project ownership is toggled per-test via this hoisted holder.
const fb = vi.hoisted(() => ({
  project: { userId: "u1", name: "Proj", description: "a project", stack: "x", summary: null, skillIds: [] as string[] }
}));

vi.mock("../src/ai", () => ai);
vi.mock("../src/memory", () => memory);
vi.mock("../src/learn", () => learn);
vi.mock("../src/usage", () => usage);
vi.mock("../src/stats", () => ({ bumpCounter: stats.bumpCounter, COUNTED_COLLECTIONS: [] }));
vi.mock("../src/util", () => ({ serverTime: util.serverTime, logEvent: util.logEvent }));
// Rate-limit middlewares are pass-through in the unit harness (covered elsewhere).
vi.mock("../src/ratelimit", () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next()
}));
vi.mock("../src/security", () => ({
  distributedRateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next()
}));
vi.mock("../src/listing", () => ({ listScoped: vi.fn(async () => []) }));
vi.mock("../src/firebase", () => {
  // A where()/limit()/get() chain that yields one topic-scoped skill, so the
  // topicIds branch of selectedSkills is exercised.
  const query = {
    where: () => query,
    limit: () => query,
    get: async () => ({ docs: [{ id: "topic-skill", data: () => ({ skillName: "T", description: "d" }) }] })
  };
  return {
    db: {
      collection: () => ({
        doc: () => ({ get: async () => ({ exists: true, data: () => fb.project }) }),
        add: async () => ({ id: "dec1" }),
        where: query.where,
        limit: query.limit,
        get: query.get
      })
    },
    admin: {}
  };
});

import { askRouter } from "../src/routes/ask";
import { designRouter } from "../src/routes/design";
import { runDesignCore } from "../src/designCore";

let server: http.Server;
let baseUrl: string;

function startApp() {
  const app = express();
  app.use(express.json());
  // Stub auth: everything downstream sees an authenticated user.
  app.use((req: Request & { userId?: string; requestId?: string }, _res, next) => {
    req.userId = "u1";
    req.requestId = "req-test";
    next();
  });
  app.use(askRouter);
  app.use(designRouter);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  ai.generateAnswer.mockResolvedValue("CANNED ANSWER");
  memory.searchMemory.mockResolvedValue([{ id: "c1", content: "ctx", score: 0.9 }]);
  memory.gatherContext.mockResolvedValue([{ id: "c1", content: "ctx", score: 0.9 }]);
  fb.project = { userId: "u1", name: "Proj", description: "a project", stack: "x", summary: null, skillIds: [] };
});

afterAll(() => {
  server?.close();
});

async function request(method: string, path: string, body?: unknown) {
  if (!server) {
    server = http.createServer(startApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("ask router — happy path", () => {
  it("answers a question and returns the retrieved sources", async () => {
    const res = await request("POST", "/ask", { question: "What is the architecture?" });
    expect(res.status).toBe(200);
    expect(res.body.question).toBe("What is the architecture?");
    expect(res.body.answer).toBe("CANNED ANSWER");
    expect(res.body.sources).toHaveLength(1);

    expect(memory.searchMemory).toHaveBeenCalledTimes(1);
    expect(ai.generateAnswer).toHaveBeenCalledTimes(1);
    expect(usage.recordUsage).toHaveBeenCalledWith("u1", "ask");
    expect(util.logEvent).toHaveBeenCalled();
  });

  it("honours the limit argument passed to memory search", async () => {
    await request("POST", "/ask", { question: "another question", limit: 3 });
    expect(memory.searchMemory).toHaveBeenCalledWith("another question", { userId: "u1" }, 3);
  });
});

// The POST /design route is now async (validate + enqueue a Cloud Tasks job).
// The actual generation logic lives in `runDesignCore` (run by the worker), so
// the success-branch coverage exercises that core directly with the same mocked
// collaborators. The GET listing stays on the real router.
describe("design core — happy path", () => {
  it("generates a design, persists it, feeds the outcome back, and responds", async () => {
    const r = await runDesignCore({ userId: "u1", projectId: "proj-123", section: "billing" });
    expect(r.id).toBe("dec1");
    expect(r.plan).toBe("CANNED ANSWER");
    expect(r.sources).toHaveLength(1);

    expect(memory.gatherContext).toHaveBeenCalled();
    expect(ai.generateAnswer).toHaveBeenCalledTimes(1);
    expect(stats.bumpCounter).toHaveBeenCalledWith("u1", "project_decisions");
    expect(usage.recordUsage).toHaveBeenCalledWith("u1", "design");
    // Self-learning loop: the design outcome is recorded back into memory.
    expect(learn.recordOutcome).toHaveBeenCalledTimes(1);
    expect(learn.recordOutcome.mock.calls[0][0]).toMatchObject({ userId: "u1", kind: "design_outcome" });
  });

  it("falls back to whole-memory context when project-scoped search is empty", async () => {
    memory.gatherContext
      .mockResolvedValueOnce([]) // project-scoped: empty
      .mockResolvedValueOnce([{ id: "c2", content: "global", score: 0.5 }]); // fallback
    const r = await runDesignCore({ userId: "u1", projectId: "proj-123" });
    // Two gatherContext calls: scoped (empty) then the user-wide fallback.
    expect(memory.gatherContext).toHaveBeenCalledTimes(2);
    expect((r.sources[0] as { id?: string }).id).toBe("c2");
  });

  it("folds the project's selected skills into the prompt", async () => {
    fb.project = {
      userId: "u1",
      name: "Proj",
      description: "a project",
      stack: "x",
      summary: null,
      skillIds: ["s1"]
    };
    await runDesignCore({ userId: "u1", projectId: "proj-123" });
    // The generated prompt includes the selected-skills section.
    const prompt = ai.generateAnswer.mock.calls[0][0] as string;
    expect(prompt).toContain("ВЫБРАННЫЕ НАВЫКИ АГЕНТА");
    expect(prompt).not.toContain("(no skills selected)");
  });

  it("treats a project with an ingested summary as a brownfield update", async () => {
    fb.project = {
      userId: "u1",
      name: "Proj",
      description: "a project",
      stack: "x",
      summary: "existing code summary from GitHub",
      skillIds: []
    };
    await runDesignCore({ userId: "u1", projectId: "proj-123" });
    const prompt = ai.generateAnswer.mock.calls[0][0] as string;
    // Brownfield phrasing (not the greenfield "с нуля" basis).
    expect(prompt).toContain("existing code summary from GitHub");
    expect(prompt).toContain("Сделай дизайн обновления проекта в целом.");
  });

  it("includes skills resolved from the selected topic categories", async () => {
    await runDesignCore({ userId: "u1", projectId: "proj-123", topicIds: ["topic-a"] });
    const prompt = ai.generateAnswer.mock.calls[0][0] as string;
    // The topic-scoped skill (skillName "T") was folded into the prompt.
    expect(prompt).toContain("- T: d");
  });

  it("GET /design lists the caller's decisions", async () => {
    const res = await request("GET", "/design");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.decisions)).toBe(true);
  });
});
