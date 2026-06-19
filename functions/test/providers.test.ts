/**
 * Unit tests — Anthropic + Azure providers (CONTRACT v3.7) and usage bucketing.
 * The HTTP layer is exercised by stubbing global fetch, so no network/keys are
 * needed and these run in the default (no-emulator) suite.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { anthropicLlm, anthropicTest } from "../src/providers/anthropic";
import { azureLlm, azureEmbedding } from "../src/providers/azure";
import { usageBucketId } from "../src/usage";

function mockFetch(status: number, body: unknown) {
  return vi.fn((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AZURE_OPENAI_ENDPOINT;
});

describe("anthropic provider", () => {
  it("posts to the Messages API and joins text blocks", async () => {
    const f = mockFetch(200, { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] });
    vi.stubGlobal("fetch", f);
    const out = await anthropicLlm("sk-ant-test", "sys", "user", 0.1);
    expect(out).toBe("hello world");
    const [url, opts] = f.mock.calls[0];
    expect(String(url)).toContain("api.anthropic.com");
    expect((opts as RequestInit | undefined)?.headers).toMatchObject({ "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" });
  });
  it("throws a coded error on non-2xx", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { error: "bad" }));
    await expect(anthropicTest("sk-ant-bad")).rejects.toThrow(/anthropic_error_401/);
  });
});

describe("azure provider", () => {
  it("requires endpoint configuration", async () => {
    await expect(azureLlm("k", "s", "u")).rejects.toThrow(/azure_not_configured/);
  });
  it("calls the configured deployment endpoint", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    const f = mockFetch(200, { data: [{ index: 0, embedding: [0.1, 0.2] }] });
    vi.stubGlobal("fetch", f);
    const v = await azureEmbedding("k", "ping");
    expect(v).toEqual([0.1, 0.2]);
    expect(String(f.mock.calls[0][0])).toContain("/openai/deployments/");
  });
});

describe("usageBucketId", () => {
  it("formats a UTC year-month bucket", () => {
    expect(usageBucketId(new Date(Date.UTC(2026, 5, 19)))).toBe("2026-06");
    expect(usageBucketId(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
  });
});
