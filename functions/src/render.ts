// JS rendering seam (Epic 1.3). Many modern pages ship an almost-empty HTML
// shell and hydrate their content with JavaScript, so static extraction yields
// little text. `readUrl` falls back to `renderWithJs` ONLY when the statically
// extracted text is too short AND `RENDER_JS_ENABLED` is set — the default
// offline/server path never depends on a heavy headless browser.
//
// The renderer is intentionally pluggable behind this seam: production can
// install a Playwright/Puppeteer-backed implementation via `setJsRenderer`, and
// tests inject a mock. The default throws loudly so enabling the flag without a
// configured engine fails visibly instead of silently returning empty content.

export type JsRenderer = (url: string) => Promise<string>;

const notConfigured: JsRenderer = async () => {
  throw new Error("renderer not configured");
};

let activeRenderer: JsRenderer = notConfigured;

// Install (or, with null, reset to the default) the active JS renderer.
export function setJsRenderer(renderer: JsRenderer | null): void {
  activeRenderer = renderer ?? notConfigured;
}

// Render `url` with the configured engine. The caller (readUrl) is responsible
// for SSRF-validating the URL BEFORE invoking this — the renderer performs its
// own network navigation and must never be pointed at a private host.
export function renderWithJs(url: string): Promise<string> {
  return activeRenderer(url);
}

// True when the JS-render fallback is explicitly enabled via env ("1"/"true").
export function jsRenderEnabled(): boolean {
  const v = (process.env.RENDER_JS_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// Below this many characters of extracted text we treat the page as a likely
// JS-rendered shell worth re-fetching through the renderer.
export const JS_RENDER_MIN_TEXT = 200;
