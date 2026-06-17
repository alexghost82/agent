import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHttpUrl } from "../src/ssrf";

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
});
