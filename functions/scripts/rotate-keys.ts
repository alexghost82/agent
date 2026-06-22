/**
 * rotate-keys.ts — re-encrypt stored secrets under the current primary key.
 *
 * Walks every `users/{uid}` document and re-encrypts each encrypted secret
 * (per-provider API keys under `apiKeys.*` and the `githubToken` PAT) that is
 * NOT already stamped with the current primary key version. Each value is
 * decrypted with whatever version it carries (legacy / no-`v` records are
 * treated as v1) and re-encrypted under `KEYS_ENC_PRIMARY_VERSION`.
 *
 * SAFETY
 *  - Dry-run by default: nothing is written unless you pass --apply.
 *  - Never destructive: if a value cannot be decrypted (e.g. its key version is
 *    not configured) it is reported and SKIPPED — never overwritten or deleted,
 *    so a missing key version can never cause data loss.
 *  - Idempotent: values already at the primary version are left untouched.
 *  - Non-encrypted legacy plaintext `githubToken` (a bare string) is skipped.
 *
 * USAGE (from functions/)
 *   # 1. Configure secrets in the environment first:
 *   export KEYS_ENC_SECRET=...            # v1 (existing)
 *   export KEYS_ENC_SECRET_V2=...         # the new key
 *   export KEYS_ENC_PRIMARY_VERSION=2     # make v2 primary
 *   export GOOGLE_APPLICATION_CREDENTIALS=...   # or FIRESTORE_EMULATOR_HOST
 *
 *   # 2. Preview (no writes):
 *   npx tsx scripts/rotate-keys.ts
 *
 *   # 3. Apply:
 *   npx tsx scripts/rotate-keys.ts --apply
 *
 * FLAGS
 *   --apply         Perform writes (default is dry-run).
 *   --user=<uid>    Limit to a single user document.
 *   --batch=<n>     Firestore page size when scanning users (default 200).
 */

import { db } from "../src/firebase";
import {
  EncryptedSecret,
  decryptSecret,
  encryptSecret,
  keyVersionOf,
  primaryKeyVersion
} from "../src/crypto";

interface Flags {
  apply: boolean;
  user?: string;
  batch: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { apply: false, batch: 200 };
  for (const arg of argv) {
    if (arg === "--apply") flags.apply = true;
    else if (arg.startsWith("--user=")) flags.user = arg.slice("--user=".length);
    else if (arg.startsWith("--batch=")) {
      const n = Number(arg.slice("--batch=".length));
      if (Number.isInteger(n) && n > 0) flags.batch = n;
    }
  }
  return flags;
}

function looksEncrypted(value: unknown): value is EncryptedSecret {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.ciphertext === "string" && typeof v.iv === "string" && typeof v.tag === "string";
}

interface Stats {
  scanned: number;
  reencrypted: number;
  skippedUpToDate: number;
  skippedPlaintext: number;
  failed: number;
}

// Re-encrypts `current` under the primary version, preserving any sibling
// metadata (e.g. last4, updatedAt) that lived alongside it in the document.
function migrateValue(
  label: string,
  current: EncryptedSecret,
  primary: number,
  stats: Stats
): EncryptedSecret | undefined {
  const fromVersion = keyVersionOf(current);
  if (fromVersion === primary) {
    stats.skippedUpToDate++;
    return undefined;
  }

  let plaintext: string;
  try {
    plaintext = decryptSecret(current);
  } catch (err) {
    stats.failed++;
    console.error(`  ! ${label}: cannot decrypt (v${fromVersion}) — SKIPPED: ${(err as Error).message}`);
    return undefined;
  }

  const next = encryptSecret(plaintext, primary);
  stats.reencrypted++;
  console.log(`  ~ ${label}: v${fromVersion} -> v${primary}`);
  // Spread original first so metadata (last4, updatedAt) is preserved, then
  // overwrite the cipher fields (ciphertext, iv, tag, v).
  return { ...current, ...next };
}

async function processUser(
  doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
  primary: number,
  flags: Flags,
  stats: Stats
): Promise<void> {
  const data = doc.data();
  if (!data) return;
  const update: Record<string, unknown> = {};

  const apiKeys = (data.apiKeys || {}) as Record<string, unknown>;
  for (const [provider, entry] of Object.entries(apiKeys)) {
    if (!looksEncrypted(entry)) continue;
    stats.scanned++;
    const migrated = migrateValue(`${doc.id} apiKeys.${provider}`, entry, primary, stats);
    if (migrated) update[`apiKeys.${provider}`] = migrated;
  }

  const githubToken = data.githubToken;
  if (typeof githubToken === "string") {
    stats.skippedPlaintext++; // legacy pre-encryption plaintext, leave as-is
  } else if (looksEncrypted(githubToken)) {
    stats.scanned++;
    const migrated = migrateValue(`${doc.id} githubToken`, githubToken, primary, stats);
    if (migrated) update.githubToken = migrated;
  }

  if (Object.keys(update).length === 0) return;
  if (flags.apply) {
    await doc.ref.update(update);
    console.log(`  = ${doc.id}: wrote ${Object.keys(update).length} field(s)`);
  } else {
    console.log(`  = ${doc.id}: would write ${Object.keys(update).length} field(s) (dry-run)`);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const primary = primaryKeyVersion();

  console.log(`rotate-keys: primary version = v${primary}, mode = ${flags.apply ? "APPLY" : "DRY-RUN"}`);
  if (flags.user) console.log(`rotate-keys: limited to user ${flags.user}`);

  const stats: Stats = {
    scanned: 0,
    reencrypted: 0,
    skippedUpToDate: 0,
    skippedPlaintext: 0,
    failed: 0
  };

  if (flags.user) {
    const doc = await db.collection("users").doc(flags.user).get();
    if (!doc.exists) {
      console.error(`rotate-keys: user ${flags.user} not found`);
      process.exitCode = 1;
      return;
    }
    await processUser(doc, primary, flags, stats);
  } else {
    // Page through the collection so very large datasets don't load at once.
    let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let q = db.collection("users").orderBy("__name__").limit(flags.batch);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        await processUser(doc, primary, flags, stats);
      }
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < flags.batch) break;
    }
  }

  console.log("rotate-keys: done");
  console.log(`  scanned secrets:        ${stats.scanned}`);
  console.log(`  re-encrypted:           ${stats.reencrypted}${flags.apply ? "" : " (dry-run)"}`);
  console.log(`  already up-to-date:     ${stats.skippedUpToDate}`);
  console.log(`  legacy plaintext PATs:  ${stats.skippedPlaintext}`);
  console.log(`  failed (skipped):       ${stats.failed}`);

  if (stats.failed > 0) {
    console.error("rotate-keys: some values could not be decrypted — keep their key version configured and re-run.");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("rotate-keys: fatal error", err);
  process.exitCode = 1;
});
