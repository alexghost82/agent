import * as crypto from "crypto";

// Symmetric encryption for per-user provider API keys.
// AES-256-GCM with a 12-byte random IV and a 16-byte auth tag.
// The 32-byte key is derived from the KEYS_ENC_SECRET master secret so the
// secret can be any length while the cipher always gets exactly 256 bits.

const ALGORITHM = "aes-256-gcm";

export interface EncryptedSecret {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex
}

function masterKey(): Buffer {
  const secret = process.env.KEYS_ENC_SECRET;
  if (!secret) {
    throw new Error("KEYS_ENC_SECRET is not configured on the server");
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex")
  };
}

export function decryptSecret(payload: EncryptedSecret): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey(), Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

export function last4(secret: string): string {
  return secret.slice(-4);
}
