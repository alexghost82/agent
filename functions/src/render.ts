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
// Tracks whether the user explicitly installed/cleared a renderer via
// `setJsRenderer`. When they have, we never auto-install the Playwright engine
// (so injected mocks and explicit resets always win).
let rendererExplicitlySet = false;

// Install (or, with null, reset to the default) the active JS renderer.
export function setJsRenderer(renderer: JsRenderer | null): void {
  activeRenderer = renderer ?? notConfigured;
  rendererExplicitlySet = true;
}

// Maximum time to spend loading + navigating a page in the headless browser.
const RENDER_NAV_TIMEOUT_MS = 20000;

// Minimal structural typing for the optional `playwright` package so we can use
// it without a hard compile-time dependency (it is an optional dependency and
// may be absent, with browsers installed separately via `playwright install`).
interface PwPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(opts?: { headless?: boolean }): Promise<PwBrowser>;
}
interface PwModule {
  chromium?: PwChromium;
}

// Build a real renderer backed by headless Chromium. It launches a browser,
// navigates with a bounded timeout, and returns the rendered body text. It does
// NOT perform any SSRF validation of its own — by contract the caller (readUrl)
// must validate the URL before invoking the renderer.
function createPlaywrightRenderer(pw: PwModule): JsRenderer {
  return async (url: string): Promise<string> => {
    const chromium = pw.chromium;
    if (!chromium) throw new Error("renderer not configured");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { timeout: RENDER_NAV_TIMEOUT_MS, waitUntil: "networkidle" });
      const text = await page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText ?? "";
      });
      return typeof text === "string" ? text : "";
    } finally {
      try {
        await browser.close();
      } catch {
        /* ignore browser cleanup errors */
      }
    }
  };
}

// Lazily install the Playwright-backed renderer the first time it is needed,
// but ONLY when the feature flag is on and the library is importable. If
// Playwright is not installed the active renderer stays `notConfigured`, so the
// default behaviour (a loud throw) is unchanged unless explicitly enabled.
function ensureRendererInstalled(): void {
  if (rendererExplicitlySet || activeRenderer !== notConfigured) return;
  if (!jsRenderEnabled()) return;
  let pw: PwModule | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pw = require("playwright") as PwModule;
  } catch {
    pw = null;
  }
  if (pw && pw.chromium) {
    activeRenderer = createPlaywrightRenderer(pw);
  }
}

// Render `url` with the configured engine. The caller (readUrl) is responsible
// for SSRF-validating the URL BEFORE invoking this — the renderer performs its
// own network navigation and must never be pointed at a private host.
export function renderWithJs(url: string): Promise<string> {
  ensureRendererInstalled();
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
