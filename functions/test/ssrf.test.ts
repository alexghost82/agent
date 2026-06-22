import { describe, it, expect, vi, afterEach } from "vitest";

// Mock DNS resolution so hostname-based SSRF checks are hermetic (no real
// outbound DNS). IP-literal tests do not touch this mock.
vi.mock("dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "dns/promises";
import { isPrivateIp, assertPublicHttpUrl, readUrl, createPinnedLookup } from "../src/ssrf";

const mockedLookup = lookup as unknown as ReturnType<typeof vi.fn>;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

// Stub global fetch to return a fixed sequence of responses (one per hop).
function stubFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error("unexpected extra fetch call");
    return r;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockedLookup.mockReset();
});

describe("isPrivateIp", () => {
  it("flags private and loopback IPv4", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
  });
  it("allows public IPv4", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("140.82.112.3")).toBe(false);
  });
  it("flags loopback/link-local/ULA IPv6", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-http protocols", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("ftp://example.com")).rejects.toThrow();
  });
  it("rejects localhost", async () => {
    await expect(assertPublicHttpUrl("http://localhost/x")).rejects.toThrow();
  });
  it("rejects private IP literals", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://127.0.0.1:8080")).rejects.toThrow();
  });
  it("rejects a host that resolves to a private address", async () => {
    mockedLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicHttpUrl("http://internal.example.com/")).rejects.toThrow(/private address/i);
  });
  it("rejects a host whose DNS mixes a public and a private address", async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ]);
    await expect(assertPublicHttpUrl("http://sneaky.example.com/")).rejects.toThrow(/private address/i);
  });
  it("allows a host that resolves to a public address", async () => {
    mockedLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertPublicHttpUrl("https://example.com/path");
    expect(url.hostname).toBe("example.com");
  });
});

describe("readUrl redirect SSRF hardening", () => {
  it("blocks a redirect to a private IP", async () => {
    stubFetchSequence([redirectResponse("http://169.254.169.254/latest/meta-data")]);
    await expect(readUrl("https://93.184.216.34/start")).rejects.toThrow(/private address/i);
  });

  it("blocks a redirect to localhost", async () => {
    stubFetchSequence([redirectResponse("http://localhost/admin")]);
    await expect(readUrl("https://93.184.216.34/start")).rejects.toThrow(/internal host/i);
  });

  it("blocks a redirect to a non-http(s) scheme", async () => {
    stubFetchSequence([redirectResponse("file:///etc/passwd")]);
    await expect(readUrl("https://93.184.216.34/start")).rejects.toThrow(/non-http/i);
  });

  it("blocks a redirect to a private host resolved via DNS", async () => {
    // First validation (the literal start URL) needs no DNS; the redirect host does.
    mockedLookup.mockResolvedValueOnce([{ address: "10.10.10.10", family: 4 }]);
    stubFetchSequence([redirectResponse("https://intranet.example.com/secret")]);
    await expect(readUrl("https://93.184.216.34/start")).rejects.toThrow(/private address/i);
  });

  it("enforces the redirect hop cap", async () => {
    // Always redirect to another public URL -> must give up after the cap.
    const fn = vi.fn(async () => redirectResponse("https://93.184.216.34/next"));
    vi.stubGlobal("fetch", fn);
    await expect(readUrl("https://93.184.216.34/start")).rejects.toThrow(/too many redirects/i);
    // original hop + 5 follows = 6 fetches before giving up.
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it("follows a legitimate public redirect chain to completion", async () => {
    stubFetchSequence([
      redirectResponse("https://93.184.216.34/step-2"),
      redirectResponse("https://93.184.216.34/final", 301),
      htmlResponse("<html><head><title>Done</title></head><body>Final destination content.</body></html>")
    ]);
    const res = await readUrl("https://93.184.216.34/start");
    expect(res.title).toBe("Done");
    expect(res.text).toContain("Final destination content.");
  });

  it("passes manual redirect mode and a pinned dispatcher to fetch", async () => {
    let capturedInit: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: any) => {
        capturedInit = init;
        return htmlResponse("<html><body>hello world body text</body></html>");
      })
    );
    await readUrl("https://93.184.216.34/page");
    expect(capturedInit.redirect).toBe("manual");
    // DNS pinning is wired through a custom dispatcher (undici Agent).
    expect(capturedInit.dispatcher).toBeTruthy();
  });
});

describe("createPinnedLookup (DNS rebinding TOCTOU mitigation)", () => {
  it("always returns the pre-verified address, ignoring the hostname", async () => {
    const pinned = createPinnedLookup([{ address: "93.184.216.34", family: 4 }]);

    // `all: true` form (used by socket connect) — a rebind target hostname must
    // never override the pinned address.
    const all = await new Promise((resolve, reject) =>
      pinned("rebind-to-private.example.com", { all: true } as any, ((err: any, addrs: any) =>
        err ? reject(err) : resolve(addrs)) as any)
    );
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);

    // Single-address form.
    const single = await new Promise((resolve, reject) =>
      pinned("rebind-to-private.example.com", {} as any, ((err: any, address: any, family: any) =>
        err ? reject(err) : resolve({ address, family })) as any)
    );
    expect(single).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("never resolves to a private IP even if real DNS would (rebinding simulation)", async () => {
    // Host was verified to a public IP; a later malicious resolution to a private
    // IP is irrelevant because the connection is pinned to the verified address.
    const pinned = createPinnedLookup([{ address: "8.8.8.8", family: 4 }]);
    const result = (await new Promise((resolve, reject) =>
      pinned("attacker-controlled.example.com", { all: true } as any, ((err: any, addrs: any) =>
        err ? reject(err) : resolve(addrs)) as any)
    )) as Array<{ address: string }>;
    expect(result.every((r) => !isPrivateIp(r.address))).toBe(true);
    expect(result).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("honors the requested address family when pinning", async () => {
    const pinned = createPinnedLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ]);
    const v6 = await new Promise((resolve, reject) =>
      pinned("dual-stack.example.com", { family: 6 } as any, ((err: any, address: any, family: any) =>
        err ? reject(err) : resolve({ address, family })) as any)
    );
    expect(v6).toEqual({ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 });
  });
});
