import { describe, it, expect, beforeAll, afterEach } from "vitest";

beforeAll(() => {
  process.env.KEYS_ENC_SECRET = "test-master-secret-for-crypto-roundtrip";
});

// Imported after the env is set so masterKey() can read it on first call.
import {
  encryptSecret,
  decryptSecret,
  reencryptSecret,
  last4,
  primaryKeyVersion,
  keyVersionOf,
  EncryptedSecret
} from "../src/crypto";

// Keep version-related env isolated between tests so the default (v1) behaviour
// is restored for every case.
afterEach(() => {
  delete process.env.KEYS_ENC_PRIMARY_VERSION;
  delete process.env.KEYS_ENC_SECRET_V2;
  delete process.env.KEYS_ENC_SECRET_V3;
});

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

  it("fails to decrypt when the IV is tampered with", () => {
    const enc = encryptSecret("sk-iv-tamper-test");
    const badIv = enc.iv.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    expect(() => decryptSecret({ ...enc, iv: badIv })).toThrow();
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

describe("crypto key versioning", () => {
  it("stamps the primary version (v1 by default) on new ciphertext", () => {
    expect(primaryKeyVersion()).toBe(1);
    const enc = encryptSecret("sk-default-version");
    expect(enc.v).toBe(1);
    expect(decryptSecret(enc)).toBe("sk-default-version");
  });

  it("decrypts legacy ciphertext that has no version field as v1", () => {
    const enc = encryptSecret("sk-legacy-shape");
    // Simulate a pre-versioning Firestore record: only {ciphertext,iv,tag}.
    const legacy: EncryptedSecret = {
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag
    };
    expect(legacy.v).toBeUndefined();
    expect(keyVersionOf(legacy)).toBe(1);
    expect(decryptSecret(legacy)).toBe("sk-legacy-shape");
  });

  it("encrypts under v2 then decrypts by selecting the v2 key", () => {
    process.env.KEYS_ENC_SECRET_V2 = "second-generation-master-secret";
    process.env.KEYS_ENC_PRIMARY_VERSION = "2";

    expect(primaryKeyVersion()).toBe(2);
    const enc = encryptSecret("sk-v2-secret");
    expect(enc.v).toBe(2);
    expect(decryptSecret(enc)).toBe("sk-v2-secret");

    // The v2 ciphertext must NOT be decryptable with the v1 key.
    const asV1: EncryptedSecret = { ...enc, v: 1 };
    expect(() => decryptSecret(asV1)).toThrow();
  });

  it("keeps old versions decryptable after the primary moves forward", () => {
    // Encrypt under v1 (default primary)...
    const v1 = encryptSecret("sk-old-under-v1");

    // ...then rotate the primary to v2.
    process.env.KEYS_ENC_SECRET_V2 = "second-generation-master-secret";
    process.env.KEYS_ENC_PRIMARY_VERSION = "2";

    // Old v1 ciphertext still decrypts because v1's secret remains configured.
    expect(decryptSecret(v1)).toBe("sk-old-under-v1");

    // New writes use v2.
    expect(encryptSecret("sk-new").v).toBe(2);
  });

  it("re-encrypts a legacy payload under the new primary version", () => {
    const original = encryptSecret("sk-needs-migration");
    const legacy: EncryptedSecret = {
      ciphertext: original.ciphertext,
      iv: original.iv,
      tag: original.tag
    };

    process.env.KEYS_ENC_SECRET_V2 = "second-generation-master-secret";
    process.env.KEYS_ENC_PRIMARY_VERSION = "2";

    const migrated = reencryptSecret(legacy);
    expect(migrated.v).toBe(2);
    expect(migrated.ciphertext).not.toBe(legacy.ciphertext);
    expect(decryptSecret(migrated)).toBe("sk-needs-migration");
  });

  it("fails cleanly when the required key version is not configured", () => {
    // A record claims v3 but KEYS_ENC_SECRET_V3 is absent.
    const enc = encryptSecret("sk-orphan");
    const orphan: EncryptedSecret = { ...enc, v: 3 };
    expect(() => decryptSecret(orphan)).toThrow(/version 3 is not available/);
  });

  it("rejects an invalid primary version configuration", () => {
    process.env.KEYS_ENC_PRIMARY_VERSION = "not-a-number";
    expect(() => primaryKeyVersion()).toThrow(/KEYS_ENC_PRIMARY_VERSION/);
  });
});
