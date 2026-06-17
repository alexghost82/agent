import * as net from "net";
import { lookup } from "dns/promises";
import * as cheerio from "cheerio";

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
    const html = (await response.text()).slice(0, 3_000_000);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, svg").remove();
    const title = $("title").text().trim() || rawUrl;
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 160000);
    return { title, text };
  } finally {
    clearTimeout(timeout);
  }
}
