import * as net from "net";
import { lookup } from "dns/promises";
import * as cheerio from "cheerio";
import { sameOrigin, parseSitemapUrls, resolveCrawlUrl } from "./pure";

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

// Validates that a URL is public http(s) and does not resolve to a private/internal address.
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
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
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("URL resolves to a private address");
    return url;
  }
  const records = await lookup(host, { all: true });
  if (!records.length) throw new Error("Could not resolve host");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error("URL resolves to a private address");
  }
  return url;
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

export async function readUrl(rawUrl: string): Promise<{ title: string; text: string }> {
  await assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(rawUrl, {
      headers: { "User-Agent": "GHOST-Agent-Builder/1.0 (read-only)" },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`Failed to fetch ${rawUrl}: ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const raw = await response.text();

    // PDFs are served as text/plain extraction best-effort: many docs hosts
    // return an HTML viewer, so we still parse as HTML when it is not a real PDF.
    if (contentType.includes("application/pdf")) {
      const text = raw.replace(/[^\x20-\x7E\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160000);
      return { title: rawUrl, text };
    }

    const html = raw.slice(0, 3_000_000);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, svg").remove();
    const title = $("title").text().trim() || rawUrl;
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 160000);
    return { title, text };
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
    const smRes = await fetch(`${origin}/sitemap.xml`, {
      headers: { "User-Agent": "GHOST-Agent-Builder/1.0 (read-only)" }
    });
    if (smRes.ok) {
      for (const u of parseSitemapUrls(await smRes.text())) {
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
        const res = await fetch(norm, { headers: { "User-Agent": "GHOST-Agent-Builder/1.0 (read-only)" } });
        if (res.ok) {
          for (const link of extractLinks((await res.text()).slice(0, 3_000_000), norm)) {
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
