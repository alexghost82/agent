import * as net from "net";
import { lookup } from "dns/promises";
import * as cheerio from "cheerio";
import { sameOrigin, parseSitemapUrls, resolveCrawlUrl } from "./pure";
import { renderWithJs, jsRenderEnabled, JS_RENDER_MIN_TEXT } from "./render";
import { extractPdfText } from "./pdf";
import { log } from "./log";

// A realistic desktop-browser User-Agent. Many public sites (Cloudflare and
// other bot shields) answer a self-identifying crawler UA with 403/404 even
// though the page renders fine in a browser, which previously surfaced as
// "source_unreachable" for perfectly valid resources. Default browser-like
// Accept headers are sent alongside for the same reason.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8";
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const FETCH_TIMEOUT_MS = 15000;
// Default cap on extracted page/PDF text. Overridable via READ_URL_MAX_CHARS so
// deployments can trade memory for completeness without a code change.
const DEFAULT_READ_URL_MAX_CHARS = 160000;

// Resolve the configured text cap, ignoring blank/invalid/non-positive values.
function readUrlMaxChars(): number {
  const raw = (process.env.READ_URL_MAX_CHARS || "").trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_READ_URL_MAX_CHARS;
}

// Heuristics for treating a response as a PDF even when the content-type is
// wrong/missing: an explicit `.pdf` URL path or the `%PDF-` file magic.
function urlPathLooksPdf(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith(".pdf");
}

function bufferLooksPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}
// Maximum number of redirects we will follow. Each hop is fully SSRF-validated
// before it is fetched, so this only bounds work, but a small cap also defends
// against redirect loops.
const MAX_REDIRECTS = 5;

export function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped
      return isPrivateIp(lower.replace("::ffff:", ""));
    }
    return false;
  }
  return true; // not a valid IP literal
}

interface PinnedAddress {
  address: string;
  family: number;
}

interface VerifiedHost {
  url: URL;
  // Every address the host resolved to (all verified public). The connection is
  // later pinned to these so it cannot be re-pointed at a different IP.
  addresses: PinnedAddress[];
}

// Core SSRF check: validates protocol + host, resolves DNS once, and confirms
// EVERY resolved address is public. Returns the parsed URL and the verified
// address set so callers can pin the outbound connection to it (defeating DNS
// rebinding between this check and the actual fetch).
async function verifyPublicHttpUrl(rawUrl: string): Promise<VerifiedHost> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("URL points to an internal host");
  }
  // If the host is already an IP literal, check it directly.
  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (isPrivateIp(host)) throw new Error("URL resolves to a private address");
    return { url, addresses: [{ address: host, family: literalFamily }] };
  }
  const records = await lookup(host, { all: true });
  if (!records.length) throw new Error("Could not resolve host");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error("URL resolves to a private address");
  }
  return { url, addresses: records.map((r) => ({ address: r.address, family: r.family })) };
}

// Validates that a URL is public http(s) and does not resolve to a private/internal
// address. Kept exported + backwards-compatible (other modules import it).
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  const { url } = await verifyPublicHttpUrl(rawUrl);
  return url;
}

// Node `dns.lookup`-compatible function that ALWAYS resolves to one of the
// pre-verified addresses, ignoring the hostname. Wiring this into the socket's
// `lookup` guarantees the connection lands on an IP we already validated as
// public, so an attacker cannot rebind the DNS name to a private IP in the
// window between validation and connect (TOCTOU). Exported for unit testing.
export function createPinnedLookup(addresses: PinnedAddress[]): net.LookupFunction {
  const fn = (hostname: string, options: unknown, callback: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address?: string | PinnedAddress[],
      family?: number
    ) => void;
    const opts = typeof options === "function" ? {} : options;
    const wantFamily =
      typeof opts === "number"
        ? opts
        : opts && typeof opts === "object"
          ? (opts as { family?: number }).family
          : undefined;

    let pool = addresses;
    if (wantFamily === 4 || wantFamily === 6) {
      const filtered = addresses.filter((a) => a.family === wantFamily);
      if (filtered.length) pool = filtered;
    }
    if (!pool.length) {
      cb(new Error("No pinned address available") as NodeJS.ErrnoException);
      return;
    }
    if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) {
      cb(null, pool.map((a) => ({ address: a.address, family: a.family })));
    } else {
      cb(null, pool[0].address, pool[0].family);
    }
  };
  return fn as unknown as net.LookupFunction;
}

// Native `fetch` (undici) re-resolves DNS on its own, so to pin the connection
// we hand it a custom dispatcher whose connector only ever returns our verified
// IP(s). SNI/servername and the Host header stay the original hostname so TLS
// and virtual hosting keep working. Best-effort: if undici is unavailable we
// fall back to no dispatcher (per-hop revalidation still applies).
let undiciAgentCtor: (new (opts: unknown) => unknown) | null = null;
try {
  // undici ships with Node and backs global fetch; require it for the Agent class.
  undiciAgentCtor = (require("undici") as { Agent: new (opts: unknown) => unknown }).Agent;
} catch {
  undiciAgentCtor = null;
}

function createPinnedDispatcher(url: URL, addresses: PinnedAddress[]): unknown {
  if (!undiciAgentCtor) return undefined;
  try {
    const connect: Record<string, unknown> = { lookup: createPinnedLookup(addresses) };
    // Preserve TLS SNI to the original hostname (we never rewrite the URL host).
    if (url.protocol === "https:") connect.servername = url.hostname;
    return new undiciAgentCtor({ connect });
  } catch {
    return undefined;
  }
}

function destroyDispatcher(d: unknown): void {
  if (d && typeof (d as { destroy?: unknown }).destroy === "function") {
    try {
      void (d as { destroy: () => unknown }).destroy();
    } catch {
      /* ignore cleanup errors */
    }
  }
}

interface SecureFetchResult {
  response: Response;
  // Must be called once the caller has finished consuming `response` so the
  // pinned dispatcher's sockets are released.
  cleanup: () => void;
}

// SSRF-safe fetch. Performs the request with manual redirect handling: the
// original URL and EVERY redirect target are re-validated with the full SSRF
// guard (scheme + private-IP resolution) before being fetched, and each
// connection is pinned to the verified IP via a custom dispatcher.
async function secureFetch(
  rawUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<SecureFetchResult> {
  let currentUrl = rawUrl;
  let lastDispatcher: unknown = undefined;

  for (let redirects = 0; ; redirects++) {
    if (redirects > MAX_REDIRECTS) {
      destroyDispatcher(lastDispatcher);
      throw new Error("Too many redirects");
    }

    let verified: VerifiedHost;
    try {
      verified = await verifyPublicHttpUrl(currentUrl);
    } catch (err) {
      destroyDispatcher(lastDispatcher);
      throw err;
    }

    const dispatcher = createPinnedDispatcher(verified.url, verified.addresses);
    const fetchInit: Record<string, unknown> = {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: DEFAULT_ACCEPT,
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
        ...(init.headers ?? {})
      },
      redirect: "manual"
    };
    if (init.signal) fetchInit.signal = init.signal;
    if (dispatcher) fetchInit.dispatcher = dispatcher;

    let response: Response;
    try {
      response = await fetch(verified.url, fetchInit as RequestInit);
    } catch (err) {
      destroyDispatcher(dispatcher);
      destroyDispatcher(lastDispatcher);
      throw err;
    }
    // The previous hop's dispatcher is no longer needed once the next response
    // has arrived.
    destroyDispatcher(lastDispatcher);
    lastDispatcher = dispatcher;

    const status = response.status;
    const location = response.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, verified.url);
      } catch {
        destroyDispatcher(dispatcher);
        throw new Error("Invalid redirect location");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        destroyDispatcher(dispatcher);
        throw new Error("Redirect to non-http(s) scheme blocked");
      }
      // Discard the redirect body and validate the next hop on the next pass.
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      currentUrl = next.toString();
      continue;
    }

    return {
      response,
      cleanup: () => destroyDispatcher(lastDispatcher)
    };
  }
}

// Same-origin <a href> links found in an HTML body, resolved to absolute URLs.
export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = resolveCrawlUrl(href, baseUrl);
    if (abs && sameOrigin(abs, baseUrl)) out.add(abs);
  });
  return [...out];
}

// SSRF-safe fetch of a text body with a hard timeout. Returns ok=false on a
// non-2xx response instead of throwing so crawl callers can skip the page.
async function fetchTextSecure(rawUrl: string, maxChars: number): Promise<{ ok: boolean; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { response, cleanup } = await secureFetch(rawUrl, { signal: controller.signal });
    try {
      if (!response.ok) return { ok: false, text: "" };
      return { ok: true, text: (await response.text()).slice(0, maxChars) };
    } finally {
      cleanup();
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function readUrl(rawUrl: string): Promise<{ title: string; text: string }> {
  const validated = await assertPublicHttpUrl(rawUrl);
  const maxChars = readUrlMaxChars();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { response, cleanup } = await secureFetch(rawUrl, { signal: controller.signal });
    try {
      if (!response.ok) throw new Error(`Failed to fetch ${rawUrl}: ${response.status}`);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      // Read the body once as bytes so PDFs can be parsed properly (Epic 1.4) and
      // HTML can still be decoded as UTF-8.
      const buf = Buffer.from(await response.arrayBuffer());

      // Real PDF parsing behind a seam (Epic 1.4). Treat the response as a PDF
      // when the content-type says so, when the URL path ends in `.pdf`, or when
      // the body starts with the `%PDF-` magic bytes — many hosts mislabel the
      // content-type (e.g. application/octet-stream) for downloadable PDFs.
      if (
        contentType.includes("application/pdf") ||
        urlPathLooksPdf(validated) ||
        bufferLooksPdf(buf)
      ) {
        const text = (await extractPdfText(buf)).slice(0, maxChars);
        return { title: rawUrl, text };
      }

      const html = buf.toString("utf8").slice(0, 3_000_000);
      const $ = cheerio.load(html);
      $("script, style, nav, footer, header, noscript, svg").remove();
      const title = $("title").text().trim() || rawUrl;
      let text = $("body").text().replace(/\s+/g, " ").trim().slice(0, maxChars);

      // JS-render fallback (Epic 1.3): a near-empty body usually means the content
      // is hydrated client-side. Re-fetch through the headless renderer, but only
      // when explicitly enabled — and re-assert the SSRF guard first because the
      // renderer does its own network navigation.
      if (text.length < JS_RENDER_MIN_TEXT && jsRenderEnabled()) {
        await assertPublicHttpUrl(rawUrl);
        try {
          const rendered = (await renderWithJs(rawUrl)).replace(/\s+/g, " ").trim().slice(0, maxChars);
          if (rendered.length > text.length) text = rendered;
        } catch (err) {
          log("warn", "js_render_failed", {
            url: rawUrl,
            message: err instanceof Error ? err.message : String(err)
          });
        }
      }
      return { title, text };
    } finally {
      cleanup();
    }
  } finally {
    clearTimeout(timeout);
  }
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

// Bounded, same-origin crawl (CONTRACT v3.5). Seeds from sitemap.xml + in-page
// links, BFS up to maxDepth, capped at maxPages. Every fetched URL passes the
// SSRF guard via readUrl/assertPublicHttpUrl. Failures on individual pages are
// skipped so one bad link does not abort the crawl.
export async function crawlSite(
  rootUrl: string,
  opts: { maxPages?: number; maxDepth?: number } = {}
): Promise<CrawledPage[]> {
  const maxPages = Math.max(1, opts.maxPages ?? (Number(process.env.INGEST_MAX_PAGES) || 20));
  const maxDepth = Math.max(0, opts.maxDepth ?? (Number(process.env.INGEST_MAX_DEPTH) || 2));

  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const queue: { url: string; depth: number }[] = [{ url: rootUrl, depth: 0 }];

  // Seed additional URLs from the sitemap when reachable.
  try {
    const origin = new URL(rootUrl).origin;
    const sm = await fetchTextSecure(`${origin}/sitemap.xml`, 3_000_000);
    if (sm.ok) {
      for (const u of parseSitemapUrls(sm.text)) {
        if (sameOrigin(u, rootUrl)) queue.push({ url: u, depth: 1 });
      }
    }
  } catch {
    /* no sitemap — fall back to link crawl */
  }

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift()!;
    const norm = url.split("#")[0];
    if (visited.has(norm)) continue;
    visited.add(norm);
    try {
      await assertPublicHttpUrl(norm);
      const page = await readUrl(norm);
      pages.push({ url: norm, title: page.title, text: page.text });
      if (depth < maxDepth && pages.length < maxPages) {
        const res = await fetchTextSecure(norm, 3_000_000);
        if (res.ok) {
          for (const link of extractLinks(res.text, norm)) {
            if (!visited.has(link.split("#")[0])) queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    } catch {
      /* skip unreachable / blocked page */
    }
  }
  return pages;
}
