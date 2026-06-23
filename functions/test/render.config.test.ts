/**
 * Unit tests — JS renderer configuration seam (Epic 1.3). Verifies env parsing
 * of `RENDER_JS_ENABLED`, that `renderWithJs` rejects when no engine is
 * configured (the loud `notConfigured` default), and that `setJsRenderer`
 * installs/clears a renderer correctly. No browser is launched here; the real
 * Playwright engine only auto-installs when the flag is on AND the lib is
 * importable, which these tests deliberately avoid.
 */
import { describe, it, expect, afterEach } from "vitest";
import { jsRenderEnabled, renderWithJs, setJsRenderer } from "../src/render";

afterEach(() => {
  setJsRenderer(null);
  delete process.env.RENDER_JS_ENABLED;
});

describe("jsRenderEnabled() env parsing (Epic 1.3)", () => {
  it("is false when the variable is unset", () => {
    delete process.env.RENDER_JS_ENABLED;
    expect(jsRenderEnabled()).toBe(false);
  });

  it('is true for "1"', () => {
    process.env.RENDER_JS_ENABLED = "1";
    expect(jsRenderEnabled()).toBe(true);
  });

  it('is true for "true" (case-insensitive, trimmed)', () => {
    process.env.RENDER_JS_ENABLED = "  TRUE  ";
    expect(jsRenderEnabled()).toBe(true);
  });

  it("is false for other values", () => {
    process.env.RENDER_JS_ENABLED = "yes";
    expect(jsRenderEnabled()).toBe(false);
  });
});

describe("renderWithJs() engine wiring (Epic 1.3)", () => {
  it("rejects with 'renderer not configured' when no engine is set", async () => {
    delete process.env.RENDER_JS_ENABLED;
    setJsRenderer(null);
    await expect(renderWithJs("https://example.com/page")).rejects.toThrow(/not configured/i);
  });

  it("uses a renderer installed via setJsRenderer(fn)", async () => {
    setJsRenderer(async (url) => `rendered:${url}`);
    await expect(renderWithJs("https://example.com/x")).resolves.toBe(
      "rendered:https://example.com/x"
    );
  });

  it("setJsRenderer(null) restores the notConfigured default", async () => {
    setJsRenderer(async () => "temporary");
    await expect(renderWithJs("https://example.com/x")).resolves.toBe("temporary");
    setJsRenderer(null);
    delete process.env.RENDER_JS_ENABLED;
    await expect(renderWithJs("https://example.com/x")).rejects.toThrow(/not configured/i);
  });
});
