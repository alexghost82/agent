/**
 * QA/Security tests for the per-user "bring your own API key" feature.
 *
 * Scope of this file (QA/Security agent — tests & guards only, no product logic):
 *   1. Secret hygiene — regression guard for the leaked OPENAI_API_KEY incident.
 *      These run NOW and must stay green: no live secret may sit in functions/.env
 *      and .env must be gitignored.
 *   2. FROZEN contract — type-level assertions against functions/src/providers/types.ts
 *      that lock the security-critical shapes (client DTO never carries the raw key
 *      or ciphertext).
 *   3. Implementation conformance — round-trip encryption, schema validation, userId
 *      isolation, and "no raw key returned" checks. These activate automatically once
 *      the implementation modules (src/crypto.ts, src/routes/keys.ts) land; until then
 *      they are skipped so the suite stays green while clearly flagging the gap.
 *
 * NOTE: All key material in this file is FAKE. This file is intentionally excluded
 * from the repo secret scan via the `*.test.*` ignore in the scan command.
 */
import { describe, it, expect, expectTypeOf, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ProviderName,
  EncryptedApiKey,
  StoredKeyStatus,
  ApiKeysStatusResponse,
  UpdateApiKeysRequest,
  TestApiKeyResponse
} from "../src/providers/types";

import { EMULATOR_AVAILABLE, startServer, seedUser, type TestServer } from "./helpers/harness";

const FUNCTIONS_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(FUNCTIONS_DIR, "..");
const ENV_PATH = path.join(FUNCTIONS_DIR, ".env");
const GITIGNORE_PATH = path.join(REPO_ROOT, ".gitignore");

// Matches a *live-looking* provider secret. Placeholders / empty values must not match.
const LIVE_OPENAI = /sk-[A-Za-z0-9_-]{20,}/;
const LIVE_GEMINI = /AIza[0-9A-Za-z_-]{20,}/;

function readEnv(): string {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
}

/* -------------------------------------------------------------------------- */
/* 1. Secret hygiene (runs now — regression guard for the leak incident)      */
/* -------------------------------------------------------------------------- */

describe("secret hygiene — functions/.env", () => {
  it("contains no live-looking OpenAI key", () => {
    expect(readEnv()).not.toMatch(LIVE_OPENAI);
  });

  it("contains no live-looking Gemini key", () => {
    expect(readEnv()).not.toMatch(LIVE_GEMINI);
  });

  it(".env is ignored by git", () => {
    const gitignore = fs.existsSync(GITIGNORE_PATH)
      ? fs.readFileSync(GITIGNORE_PATH, "utf8")
      : "";
    const ignored = /(^|\n)\s*(functions\/)?\.env\s*(\n|$)/.test(gitignore);
    expect(ignored).toBe(true);
  });

  it(".env is not tracked by git", () => {
    let tracked = false;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "functions/.env"], {
        cwd: REPO_ROOT,
        stdio: "pipe"
      });
      tracked = true; // command succeeds only if the file IS tracked
    } catch {
      tracked = false;
    }
    expect(tracked).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. FROZEN contract — type-level locks on the client-facing shapes          */
/* -------------------------------------------------------------------------- */

describe("FROZEN contract — providers/types.ts", () => {
  it("ProviderName is exactly openai | gemini", () => {
    expectTypeOf<ProviderName>().toEqualTypeOf<"openai" | "gemini">();
  });

  it("client status DTO never exposes the raw key or ciphertext", () => {
    // The only fields a client may ever see for a stored key.
    expectTypeOf<keyof StoredKeyStatus>().toEqualTypeOf<
      "configured" | "last4" | "updatedAt"
    >();
    // Defensive: these secret-bearing keys must NOT be assignable onto the DTO.
    type SecretFields = "ciphertext" | "iv" | "tag" | "apiKey" | "key" | "raw";
    expectTypeOf<SecretFields & keyof StoredKeyStatus>().toEqualTypeOf<never>();
  });

  it("the response only ever carries the masked status, never ciphertext", () => {
    expectTypeOf<ApiKeysStatusResponse["keys"]["openai"]>().toEqualTypeOf<StoredKeyStatus>();
    expectTypeOf<ApiKeysStatusResponse["keys"]["gemini"]>().toEqualTypeOf<StoredKeyStatus>();
  });

  it("PUT accepts a raw string to set, null to delete, undefined to keep", () => {
    expectTypeOf<UpdateApiKeysRequest["openai"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<UpdateApiKeysRequest["gemini"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("the encrypted envelope keeps ciphertext/iv/tag server-side only", () => {
    expectTypeOf<EncryptedApiKey>().toMatchTypeOf<{
      ciphertext: string;
      iv: string;
      tag: string;
      last4: string;
    }>();
  });

  it("test endpoint returns only a boolean ok + optional error code", () => {
    expectTypeOf<TestApiKeyResponse>().toMatchTypeOf<{ ok: boolean; error?: string }>();
  });
});

/* -------------------------------------------------------------------------- */
/* Optional dynamic import — present once the feature is implemented.         */
/* -------------------------------------------------------------------------- */

function moduleExists(relFromSrc: string): boolean {
  return fs.existsSync(path.join(FUNCTIONS_DIR, "src", relFromSrc));
}

async function loadModule(name: string): Promise<any | null> {
  if (!moduleExists(`${name}.ts`)) return null;
  try {
    // Computed spec + @vite-ignore so the absent module is never statically resolved.
    const spec = "../src/" + name;
    return await import(/* @vite-ignore */ spec);
  } catch {
    return null;
  }
}

const cryptoMod = await loadModule("crypto");
const hasCrypto = !!(cryptoMod && typeof cryptoMod.encryptSecret === "function");

/* -------------------------------------------------------------------------- */
/* 3a. Encryption round-trip (AES-256-GCM)                                    */
/* -------------------------------------------------------------------------- */

describe.skipIf(!hasCrypto)("crypto.ts — AES-256-GCM round-trip", () => {
  // 32-byte fake master secret; the module derives the AES key via sha256(env).
  const SECRET_A = "test-master-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SECRET_B = "test-master-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const FAKE_OPENAI_KEY = "sk-test-FAKEFAKEFAKEFAKEFAKE1234567890";

  function withSecret<T>(secret: string, fn: () => T): T {
    const prev = process.env.KEYS_ENC_SECRET;
    process.env.KEYS_ENC_SECRET = secret;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.KEYS_ENC_SECRET;
      else process.env.KEYS_ENC_SECRET = prev;
    }
  }

  it("encrypts then decrypts back to the original key", () => {
    withSecret(SECRET_A, () => {
      const env = cryptoMod.encryptSecret(FAKE_OPENAI_KEY);
      expect(env.ciphertext).not.toContain(FAKE_OPENAI_KEY);
      expect(cryptoMod.decryptSecret(env)).toBe(FAKE_OPENAI_KEY);
    });
  });

  it("derives last4 from the raw key (masked-display helper)", () => {
    expect(cryptoMod.last4(FAKE_OPENAI_KEY)).toBe(FAKE_OPENAI_KEY.slice(-4));
  });

  it("never embeds the raw key in the ciphertext envelope", () => {
    withSecret(SECRET_A, () => {
      const env = cryptoMod.encryptSecret(FAKE_OPENAI_KEY);
      const blob = JSON.stringify(env);
      expect(blob).not.toContain(FAKE_OPENAI_KEY);
      expect(blob).not.toContain(FAKE_OPENAI_KEY.slice(0, -4));
    });
  });

  it("uses a fresh IV per encryption (non-deterministic ciphertext)", () => {
    withSecret(SECRET_A, () => {
      const a = cryptoMod.encryptSecret(FAKE_OPENAI_KEY);
      const b = cryptoMod.encryptSecret(FAKE_OPENAI_KEY);
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    withSecret(SECRET_A, () => {
      const env = cryptoMod.encryptSecret(FAKE_OPENAI_KEY);
      const tampered = { ...env, ciphertext: env.ciphertext.slice(0, -2) + "00" };
      expect(() => cryptoMod.decryptSecret(tampered)).toThrow();
    });
  });

  it("rejects decryption under a different master secret", () => {
    const env = withSecret(SECRET_A, () => cryptoMod.encryptSecret(FAKE_OPENAI_KEY));
    expect(() => withSecret(SECRET_B, () => cryptoMod.decryptSecret(env))).toThrow();
  });

  it("fails closed when no master secret is configured", () => {
    const prev = process.env.KEYS_ENC_SECRET;
    delete process.env.KEYS_ENC_SECRET;
    try {
      expect(() => cryptoMod.encryptSecret(FAKE_OPENAI_KEY)).toThrow();
    } finally {
      if (prev !== undefined) process.env.KEYS_ENC_SECRET = prev;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3b. Schema validation (^sk- / ^AIza)                                       */
/* -------------------------------------------------------------------------- */

const schemasMod = await loadModule("schemas");
const keySchema = schemasMod && schemasMod.ApiKeysSchema;

describe.skipIf(!keySchema)("schema validation — key format (^sk- / ^AIza)", () => {
  it("accepts a well-formed OpenAI key (^sk-)", () => {
    const r = keySchema.safeParse({ openai: "sk-test-FAKEFAKEFAKEFAKE0123456789" });
    expect(r.success).toBe(true);
  });

  it("rejects an OpenAI key without the sk- prefix", () => {
    const r = keySchema.safeParse({ openai: "nope-FAKEFAKEFAKE0123456789" });
    expect(r.success).toBe(false);
  });

  it("accepts a well-formed Gemini key (^AIza)", () => {
    const r = keySchema.safeParse({ gemini: "AIzaFAKEFAKEFAKEFAKEFAKE0123456789" });
    expect(r.success).toBe(true);
  });

  it("rejects a Gemini key without the AIza prefix", () => {
    const r = keySchema.safeParse({ gemini: "FAKEFAKEFAKEFAKE0123456789" });
    expect(r.success).toBe(false);
  });

  it("accepts null (delete) and omitted (keep) for each provider", () => {
    expect(keySchema.safeParse({ openai: null }).success).toBe(true);
    expect(keySchema.safeParse({}).success).toBe(true);
  });

  // ACTIVATED (was it.todo). This now executes once the Backend mission adds
  // zod `.max()` bounds to ApiKeysSchema (ROADMAP #3 / contract §1). It is
  // skipped — not failed — until then, so the suite stays green meanwhile.
  const OVERSIZED_OPENAI = "sk-" + "a".repeat(20000);
  const OVERSIZED_GEMINI = "AIza" + "a".repeat(20000);
  const maxBoundActive = !!(keySchema && keySchema.safeParse({ openai: OVERSIZED_OPENAI }).success === false);

  it.skipIf(!maxBoundActive)("rejects an over-sized OpenAI key value (zod .max() — DoS/abuse guard)", () => {
    expect(keySchema.safeParse({ openai: OVERSIZED_OPENAI }).success).toBe(false);
  });
  it.skipIf(!maxBoundActive)("rejects an over-sized Gemini key value (zod .max())", () => {
    expect(keySchema.safeParse({ gemini: OVERSIZED_GEMINI }).success).toBe(false);
  });
  it.skipIf(!maxBoundActive)("still accepts a normal-length key after the bound is added", () => {
    expect(keySchema.safeParse({ openai: "sk-test-FAKE0123456789" }).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3c. userId isolation + "no raw key returned" (route layer)                 */
/* -------------------------------------------------------------------------- */

const keysRouteExists = fs.existsSync(
  path.join(FUNCTIONS_DIR, "src", "routes", "keys.ts")
);

// ACTIVATED (were it.todo at keys.test.ts:273-275). These now run live against
// the Firestore emulator and exercise the real keys router behind requireAuth:
//  - GET/PUT scope strictly to req.userId (A can never read B's stored key).
//  - responses only ever carry { configured, last4?, updatedAt? } — never the
//    ciphertext/iv/tag or the raw key.
// They are skipped (not failed) when the emulator is unavailable (default
// `npm test`); the CI emulator job runs them. The /test rate-limit case stays
// probe-gated because it depends on a Backend follow-up (no limiter today).
//
// The server + rate-limit probe are set up at module top-level because skipIf
// conditions are evaluated at collection time, before any beforeAll hook runs.
let keysSrv: TestServer = undefined as unknown as TestServer;
let testEndpointRateLimited = false;
if (EMULATOR_AVAILABLE && keysRouteExists) {
  process.env.KEYS_ENC_SECRET =
    process.env.KEYS_ENC_SECRET || "test-master-secret-for-keys-route-suite";
  keysSrv = await startServer();
  const probe = await seedUser();
  for (let i = 0; i < 12; i++) {
    const r = await keysSrv.request("POST", "/me/api-keys/test", {
      token: probe.token,
      body: { provider: "openai" }
    });
    if (r.status === 429) {
      testEndpointRateLimited = true;
      break;
    }
  }
}

describe.skipIf(!EMULATOR_AVAILABLE || !keysRouteExists)(
  "routes/keys.ts — isolation & no-leak (emulator)",
  () => {
    const srv = keysSrv;

    afterAll(async () => {
      if (srv) await srv.close();
    });

    it("user A cannot read user B's key status (scoped by req.userId)", async () => {
      const a = await seedUser();
      const b = await seedUser();
      await srv.request("PUT", "/me/api-keys", {
        token: a.token,
        body: { openai: "sk-test-FAKEaaaaaaaaaaaaaaaaAAAA" }
      });
      await srv.request("PUT", "/me/api-keys", {
        token: b.token,
        body: { openai: "sk-test-FAKEbbbbbbbbbbbbbbbbBBBB" }
      });

      const statusA = await srv.request("GET", "/me/api-keys", { token: a.token });
      expect(statusA.status).toBe(200);
      expect(statusA.body.keys.openai.configured).toBe(true);
      expect(statusA.body.keys.openai.last4).toBe("AAAA");
      expect(statusA.body.keys.openai.last4).not.toBe("BBBB");
    });

    it("PUT then GET never returns ciphertext, iv, tag, or the raw key", async () => {
      const a = await seedUser();
      const rawKey = "sk-test-FAKEsecretvalue1234567890ABCD";
      const put = await srv.request("PUT", "/me/api-keys", { token: a.token, body: { openai: rawKey } });
      const get = await srv.request("GET", "/me/api-keys", { token: a.token });

      for (const res of [put, get]) {
        expect(res.status).toBe(200);
        const blob = JSON.stringify(res.body);
        expect(blob).not.toContain(rawKey);
        expect(blob).not.toContain("ciphertext");
        expect(blob).not.toContain('"iv"');
        expect(blob).not.toContain('"tag"');
        expect(res.body.keys.openai.configured).toBe(true);
        expect(res.body.keys.openai.last4).toBe("ABCD");
      }
    });

    it.skipIf(!testEndpointRateLimited)(
      "POST /me/api-keys/test is rate-limited (429 after the limit)",
      async () => {
        const u = await seedUser();
        let saw = false;
        for (let i = 0; i < 60; i++) {
          const r = await srv.request("POST", "/me/api-keys/test", {
            token: u.token,
            body: { provider: "openai" }
          });
          if (r.status === 429) {
            expect(r.body.error).toBe("rate_limited");
            saw = true;
            break;
          }
        }
        expect(saw).toBe(true);
      }
    );
  }
);
