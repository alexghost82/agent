import * as crypto from "crypto";

// Symmetric encryption for per-user provider API keys and GitHub PATs.
// AES-256-GCM with a 12-byte random IV and a 16-byte auth tag.
//
// KEY VERSIONING
// --------------
// Each 32-byte AES key is derived as sha256(<master secret>) so the master
// secret can be any length while the cipher always gets exactly 256 bits.
// Multiple master secrets can be configured at once, each keyed by an integer
// version:
//
//   v1  ->  process.env.KEYS_ENC_SECRET          (the original / legacy secret)
//   v2  ->  process.env.KEYS_ENC_SECRET_V2
//   v3  ->  process.env.KEYS_ENC_SECRET_V3
//   ...
//
// The version used to encrypt is stamped onto the payload as `v`. On decrypt we
// select the key by the stored `v`. A payload with NO `v` field is legacy data
// written before versioning existed; it is decrypted with v1 (= the existing
// sha256(KEYS_ENC_SECRET) key) so old ciphertext keeps working unchanged.
//
// The version used for NEW encryptions ("primary") is `KEYS_ENC_PRIMARY_VERSION`
// (an integer), defaulting to 1. Rotation = configure the new secret, point the
// primary at it; all previous versions remain available for decryption until you
// have re-encrypted everything (see scripts/rotate-keys.ts) and retired them.

const ALGORITHM = "aes-256-gcm";

// Legacy ciphertext predates the `v` field; treat it as this version.
export const LEGACY_KEY_VERSION = 1;

export interface EncryptedSecret {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex
  // Key version used to encrypt. Optional & absent on legacy records (=> v1).
  // This is a superset of the original {ciphertext,iv,tag} shape, so existing
  // Firestore reads/writes and object spreads in the routes keep working.
  v?: number;
}

// Resolves the env var name that holds the master secret for a given version.
// v1 maps to the original KEYS_ENC_SECRET so legacy data stays decryptable.
function envNameForVersion(version: number): string {
  return version === 1 ? "KEYS_ENC_SECRET" : `KEYS_ENC_SECRET_V${version}`;
}

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid encryption key version: ${String(version)}`);
  }
}

// Derives the 32-byte AES key for a version. Derivation matches the original
// implementation for v1 (sha256(KEYS_ENC_SECRET)) so existing ciphertext is
// unaffected. Throws a descriptive error when the version's secret is absent so
// a missing key version can never be silently swallowed (which would risk
// data loss). Keys are derived per call (not cached) so the process can pick up
// env changes — required by callers that toggle secrets at runtime.
function keyForVersion(version: number): Buffer {
  assertValidVersion(version);
  const envName = envNameForVersion(version);
  const secret = process.env[envName];
  if (!secret) {
    if (version === 1) {
      // Preserve the original error so existing callers/tests still match.
      throw new Error("KEYS_ENC_SECRET is not configured on the server");
    }
    throw new Error(
      `Encryption key version ${version} is not available (${envName} is not configured)`
    );
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

// The version new encryptions are stamped with. Defaults to v1 so behaviour is
// unchanged until an operator opts in by setting KEYS_ENC_PRIMARY_VERSION.
export function primaryKeyVersion(): number {
  const raw = process.env.KEYS_ENC_PRIMARY_VERSION;
  if (raw === undefined || raw === "") return LEGACY_KEY_VERSION;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid KEYS_ENC_PRIMARY_VERSION: ${raw}`);
  }
  return parsed;
}

// The version a stored payload was encrypted under (legacy/no-`v` => v1).
export function keyVersionOf(payload: Pick<EncryptedSecret, "v">): number {
  return payload.v ?? LEGACY_KEY_VERSION;
}

// Encrypts `plaintext`. By default the current primary version is used; pass an
// explicit `version` to force a specific key (used by tests and tooling). The
// returned object is always a superset of the legacy {ciphertext,iv,tag} shape.
export function encryptSecret(plaintext: string, version?: number): EncryptedSecret {
  const v = version ?? primaryKeyVersion();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyForVersion(v), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    v
  };
}

// Decrypts a payload, selecting the key by its stamped version. A missing `v`
// is treated as the legacy v1 key. Throws if the required key version is not
// configured, or if GCM authentication fails (tampered ciphertext/iv/tag).
export function decryptSecret(payload: EncryptedSecret): string {
  const key = keyForVersion(keyVersionOf(payload));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

// Re-encrypts an existing payload under the current primary version, preserving
// the plaintext. Decryption uses whatever version the payload carries, so this
// safely migrates both legacy (no-`v`) and versioned records. Used by the
// rotation/migration tooling in scripts/rotate-keys.ts.
export function reencryptSecret(payload: EncryptedSecret): EncryptedSecret {
  return encryptSecret(decryptSecret(payload), primaryKeyVersion());
}

export function last4(secret: string): string {
  return secret.slice(-4);
}
