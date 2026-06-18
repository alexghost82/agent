import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.KEYS_ENC_SECRET = "test-master-secret-for-crypto-roundtrip";
});

// Imported after the env is set so masterKey() can read it on first call.
import { encryptSecret, decryptSecret, last4 } from "../src/crypto";

describe("crypto round-trip", () => {
  it("decrypts back to the original plaintext", () => {
    const plaintext = "sk-proj-abc123DEF456ghi789";
    const enc = encryptSecret(plaintext);
    expect(enc.ciphertext).not.toContain(plaintext);
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  it("produces a unique IV per call (non-deterministic ciphertext)", () => {
    const a = encryptSecret("AIzaSyExampleKeyValue00000000000000000");
    const b = encryptSecret("AIzaSyExampleKeyValue00000000000000000");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("exposes only the last 4 characters as a hint", () => {
    expect(last4("sk-proj-abcd1234")).toBe("1234");
  });

  it("fails to decrypt when the auth tag is tampered with", () => {
    const enc = encryptSecret("sk-tamper-test");
    const badTag = enc.tag.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    expect(() => decryptSecret({ ...enc, tag: badTag })).toThrow();
  });

  it("throws when the master secret is missing", () => {
    const saved = process.env.KEYS_ENC_SECRET;
    delete process.env.KEYS_ENC_SECRET;
    try {
      expect(() => encryptSecret("x")).toThrow(/KEYS_ENC_SECRET/);
    } finally {
      process.env.KEYS_ENC_SECRET = saved;
    }
  });
});
