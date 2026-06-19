/**
 * Unit tests — JS-render fallback in readUrl (Epic 1.3). No emulator/network:
 * global fetch is stubbed and the renderer is injected via the seam. Uses a
 * public IP literal so the SSRF guard passes without DNS, and verifies the
 * guard blocks the render path for private hosts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readUrl } from "../src/ssrf";
import { setJsRenderer } from "../src/render";

function stubFetchHtml(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  setJsRenderer(null);
  delete process.env.RENDER_JS_ENABLED;
});

describe("readUrl JS-render fallback (Epic 1.3)", () => {
  it("uses the renderer when extracted text is short and the flag is on", async () => {
    process.env.RENDER_JS_ENABLED = "1";
    const renderer = vi.fn(async () => "Fully rendered client-side content. ".repeat(20));
    setJsRenderer(renderer);
    stubFetchHtml("<html><body>hi</body></html>");

    const res = await readUrl("https://93.184.216.34/page");
    expect(renderer).toHaveBeenCalledWith("https://93.184.216.34/page");
    expect(res.text).toContain("Fully rendered client-side content.");
  });

  it("keeps prior behaviour (no render) when the flag is off", async () => {
    delete process.env.RENDER_JS_ENABLED;
    const renderer = vi.fn(async () => "should not be used");
    setJsRenderer(renderer);
    stubFetchHtml("<html><body>hi</body></html>");

    const res = await readUrl("https://93.184.216.34/page");
    expect(renderer).not.toHaveBeenCalled();
    expect(res.text).toBe("hi");
  });

  it("does not render long pages even with the flag on", async () => {
    process.env.RENDER_JS_ENABLED = "1";
    const renderer = vi.fn(async () => "renderer output");
    setJsRenderer(renderer);
    const long = "This page already has plenty of static content. ".repeat(20);
    stubFetchHtml(`<html><body>${long}</body></html>`);

    const res = await readUrl("https://93.184.216.34/page");
    expect(renderer).not.toHaveBeenCalled();
    expect(res.text).toContain("plenty of static content");
  });

  it("SSRF guard blocks the render path for private hosts", async () => {
    process.env.RENDER_JS_ENABLED = "1";
    const renderer = vi.fn(async () => "x".repeat(500));
    setJsRenderer(renderer);
    stubFetchHtml("<html><body>hi</body></html>");

    await expect(readUrl("http://127.0.0.1/secret")).rejects.toThrow();
    expect(renderer).not.toHaveBeenCalled();
  });
});
