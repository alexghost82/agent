/**
 * Unit tests — AI provider adapters (src/providers/*).
 *
 * The SDK-backed providers (OpenAI, Gemini) are tested by mocking the vendor SDK
 * modules; the fetch-backed providers (Anthropic, Azure) are tested by stubbing
 * global fetch. No network, no real keys — runs in the default (no-emulator)
 * suite. Existing anthropic/azure happy paths live in providers.test.ts; this
 * file fills in the remaining adapters and branches to lift providers/** to the
 * raised coverage gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* -------------------------------------------------------------------------- */
/* SDK mocks (hoisted so vi.mock factories can reference them)                */
/* -------------------------------------------------------------------------- */

const oai = vi.hoisted(() => ({
  embeddingsCreate: vi.fn(),
  chatCreate: vi.fn(),
  modelsList: vi.fn(),
  ctor: vi.fn()
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    embeddings = { create: oai.embeddingsCreate };
    chat = { completions: { create: oai.chatCreate } };
    models = { list: oai.modelsList };
    constructor(opts: { apiKey: string }) {
      oai.ctor(opts);
    }
  }
}));

const gem = vi.hoisted(() => {
  const embedContent = vi.fn();
  const batchEmbedContents = vi.fn();
  const generateContent = vi.fn();
  const getGenerativeModel = vi.fn(() => ({ embedContent, batchEmbedContents, generateContent }));
  const ctor = vi.fn();
  return { embedContent, batchEmbedContents, generateContent, getGenerativeModel, ctor };
});

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = gem.getGenerativeModel;
    constructor(key: string) {
      gem.ctor(key);
    }
  }
}));

import {
  openaiEmbedding,
  openaiEmbeddingBatch,
  openaiLlm,
  openaiTest
} from "../src/providers/openai";
import {
  geminiEmbedding,
  geminiEmbeddingBatch,
  geminiLlm,
  geminiTest
} from "../src/providers/gemini";
import { anthropicLlm, anthropicTest } from "../src/providers/anthropic";
import {
  azureLlm,
  azureEmbedding,
  azureEmbeddingBatch,
  azureTest
} from "../src/providers/azure";

function mockFetch(status: number, body: unknown) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    )
  );
}

// Each test uses a unique key so the per-key LRU client cache never returns a
// client primed by a previous test.
let keySeq = 0;
const freshKey = (p = "k") => `${p}-${keySeq++}`;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_CHAT_MODEL;
  delete process.env.GEMINI_EMBED_MODEL;
  delete process.env.GEMINI_CHAT_MODEL;
  delete process.env.ANTHROPIC_CHAT_MODEL;
  delete process.env.ANTHROPIC_MAX_TOKENS;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_VERSION;
  delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  delete process.env.AZURE_OPENAI_EMBED_DEPLOYMENT;
});

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

describe("openai provider", () => {
  it("returns the first embedding vector", async () => {
    oai.embeddingsCreate.mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    const v = await openaiEmbedding(freshKey(), "hello");
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(oai.embeddingsCreate).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: "hello" });
  });

  it("batch embedding returns [] for empty input without calling the SDK", async () => {
    const v = await openaiEmbeddingBatch(freshKey(), []);
    expect(v).toEqual([]);
    expect(oai.embeddingsCreate).not.toHaveBeenCalled();
  });

  it("batch embedding sorts vectors back into input order", async () => {
    oai.embeddingsCreate.mockResolvedValue({
      data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
        { index: 2, embedding: [3] }
      ]
    });
    const v = await openaiEmbeddingBatch(freshKey(), ["a", "b", "c"]);
    expect(v).toEqual([[1], [2], [3]]);
  });

  it("llm returns the message content and honours the model env override", async () => {
    process.env.OPENAI_CHAT_MODEL = "gpt-4o-custom";
    oai.chatCreate.mockResolvedValue({ choices: [{ message: { content: "answer" } }] });
    const out = await openaiLlm(freshKey(), "sys", "user", 0.7);
    expect(out).toBe("answer");
    expect(oai.chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-custom", temperature: 0.7 })
    );
  });

  it("llm coerces missing content to an empty string", async () => {
    oai.chatCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    expect(await openaiLlm(freshKey(), "s", "u")).toBe("");
  });

  it("test probe lists models", async () => {
    oai.modelsList.mockResolvedValue({ data: [] });
    await expect(openaiTest(freshKey())).resolves.toBeUndefined();
    expect(oai.modelsList).toHaveBeenCalledOnce();
  });

  it("reuses a cached client for the same key", async () => {
    oai.embeddingsCreate.mockResolvedValue({ data: [{ index: 0, embedding: [1] }] });
    const key = freshKey();
    await openaiEmbedding(key, "a");
    await openaiEmbedding(key, "b");
    expect(oai.ctor).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Gemini                                                                     */
/* -------------------------------------------------------------------------- */

describe("gemini provider", () => {
  it("returns embedding values", async () => {
    gem.embedContent.mockResolvedValue({ embedding: { values: [0.4, 0.5] } });
    const v = await geminiEmbedding(freshKey(), "hi");
    expect(v).toEqual([0.4, 0.5]);
    expect(gem.embedContent).toHaveBeenCalledWith("hi");
  });

  it("batch embedding returns [] for empty input", async () => {
    const v = await geminiEmbeddingBatch(freshKey(), []);
    expect(v).toEqual([]);
    expect(gem.batchEmbedContents).not.toHaveBeenCalled();
  });

  it("batch embedding maps each result's values and honours the embed model env", async () => {
    process.env.GEMINI_EMBED_MODEL = "embed-custom";
    gem.batchEmbedContents.mockResolvedValue({ embeddings: [{ values: [1] }, { values: [2] }] });
    const v = await geminiEmbeddingBatch(freshKey(), ["a", "b"]);
    expect(v).toEqual([[1], [2]]);
    expect(gem.getGenerativeModel).toHaveBeenCalledWith({ model: "embed-custom" });
  });

  it("llm passes the system instruction and returns text(), honouring the chat model env", async () => {
    process.env.GEMINI_CHAT_MODEL = "gemini-custom";
    gem.generateContent.mockResolvedValue({ response: { text: () => "gen-reply" } });
    const out = await geminiLlm(freshKey(), "system!", "user!", 0.3);
    expect(out).toBe("gen-reply");
    expect(gem.getGenerativeModel).toHaveBeenCalledWith({
      model: "gemini-custom",
      systemInstruction: "system!"
    });
    expect(gem.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ generationConfig: { temperature: 0.3 } })
    );
  });

  it("llm falls back to the default chat model when the env is unset", async () => {
    gem.generateContent.mockResolvedValue({ response: { text: () => "x" } });
    await geminiLlm(freshKey(), "s", "u");
    expect(gem.getGenerativeModel).toHaveBeenCalledWith({
      model: "gemini-1.5-flash",
      systemInstruction: "s"
    });
  });

  it("test probe embeds a ping", async () => {
    gem.embedContent.mockResolvedValue({ embedding: { values: [0] } });
    await expect(geminiTest(freshKey())).resolves.toBeUndefined();
    expect(gem.embedContent).toHaveBeenCalledWith("ping");
  });
});

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

describe("anthropic provider (additional branches)", () => {
  it("filters non-text blocks, joins text, trims, and uses default max tokens", async () => {
    const f = mockFetch(200, {
      content: [
        { type: "text", text: " hello " },
        { type: "tool_use", text: "ignored" },
        { type: "text", text: "world " }
      ]
    });
    vi.stubGlobal("fetch", f);
    const out = await anthropicLlm("sk-ant", "sys", "user");
    expect(out).toBe("hello world");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.2);
    expect(body.model).toBe("claude-3-5-sonnet-latest");
  });

  it("honours the chat model and max tokens env overrides", async () => {
    process.env.ANTHROPIC_CHAT_MODEL = "claude-custom";
    process.env.ANTHROPIC_MAX_TOKENS = "123";
    const f = mockFetch(200, { content: [{ type: "text", text: "ok" }] });
    vi.stubGlobal("fetch", f);
    await anthropicLlm("sk-ant", "s", "u", 0.9);
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("claude-custom");
    expect(body.max_tokens).toBe(123);
  });

  it("handles a response with no content array", async () => {
    vi.stubGlobal("fetch", mockFetch(200, {}));
    expect(await anthropicLlm("sk-ant", "s", "u")).toBe("");
  });

  it("coerces a text block missing its text field to an empty string", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { content: [{ type: "text" }, { type: "text", text: "kept" }] }));
    expect(await anthropicLlm("sk-ant", "s", "u")).toBe("kept");
  });

  it("llm throws a coded error on non-2xx", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: "x" }));
    await expect(anthropicLlm("sk-ant", "s", "u")).rejects.toThrow(/anthropic_error_500/);
  });

  it("test probe resolves on a 2xx response", async () => {
    vi.stubGlobal("fetch", mockFetch(200, {}));
    await expect(anthropicTest("sk-ant")).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Azure                                                                      */
/* -------------------------------------------------------------------------- */

describe("azure provider (additional branches)", () => {
  it("strips trailing slashes from the endpoint and applies version + deployment defaults", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com///";
    const f = mockFetch(200, { data: [{ index: 0, embedding: [0.1] }] });
    vi.stubGlobal("fetch", f);
    await azureEmbedding("k", "ping");
    const url = String(f.mock.calls[0][0]);
    expect(url).toBe(
      "https://r.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01"
    );
  });

  it("honours api-version and deployment env overrides", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    process.env.AZURE_OPENAI_API_VERSION = "2025-01-01";
    process.env.AZURE_OPENAI_CHAT_DEPLOYMENT = "chat-dep";
    const f = mockFetch(200, { choices: [{ message: { content: "hi" } }] });
    vi.stubGlobal("fetch", f);
    const out = await azureLlm("k", "s", "u", 0.5);
    expect(out).toBe("hi");
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/openai/deployments/chat-dep/chat/completions");
    expect(url).toContain("api-version=2025-01-01");
  });

  it("llm coerces a missing message to an empty string", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    vi.stubGlobal("fetch", mockFetch(200, { choices: [] }));
    expect(await azureLlm("k", "s", "u")).toBe("");
  });

  it("embedding batch returns [] for empty input", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    const f = mockFetch(200, {});
    vi.stubGlobal("fetch", f);
    expect(await azureEmbeddingBatch("k", [])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("embedding batch sorts vectors back into input order", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = "embed-dep";
    vi.stubGlobal(
      "fetch",
      mockFetch(200, {
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] }
        ]
      })
    );
    expect(await azureEmbeddingBatch("k", ["a", "b"])).toEqual([[1], [2]]);
  });

  it("throws a coded error on non-2xx", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    vi.stubGlobal("fetch", mockFetch(403, {}));
    await expect(azureEmbedding("k", "x")).rejects.toThrow(/azure_error_403/);
  });

  it("test probe embeds a ping against the configured endpoint", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    const f = mockFetch(200, { data: [{ index: 0, embedding: [0] }] });
    vi.stubGlobal("fetch", f);
    await expect(azureTest("k")).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledOnce();
  });

  it("throws azure_not_configured when the endpoint env is missing", async () => {
    await expect(azureEmbedding("k", "x")).rejects.toThrow(/azure_not_configured/);
  });
});
