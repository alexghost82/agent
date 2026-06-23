/**
 * migrate-embeddings-to-vector.ts — convert legacy `knowledge_chunks.embedding`
 * values stored as plain `number[]` arrays into native Firestore vector values,
 * so Firestore Vector Search (`findNearest`) actually matches them.
 *
 * Each legacy embedding is normalized to the canonical TARGET_EMBED_DIM (so old
 * 768-dim Gemini vectors and 1536-dim OpenAI vectors all fit the single vector
 * index) and rewritten via FieldValue.vector(). Documents already stored as a
 * vector value are left untouched (idempotent / safe to re-run).
 *
 * SAFETY
 *  - DRY-RUN BY DEFAULT: without --commit it only counts how many docs WOULD be
 *    converted (and how many are already vectors). Nothing is written.
 *  - --commit performs the rewrite in bounded batches.
 *
 * NOTE: if you have just run a full data wipe, there is nothing to backfill —
 * every NEW ingestion already writes vector values via src/vector.ts#toVector.
 *
 * USAGE (from functions/)
 *   npx tsx scripts/migrate-embeddings-to-vector.ts            # dry-run
 *   npx tsx scripts/migrate-embeddings-to-vector.ts --commit   # apply
 *
 * BOOTSTRAP: imports the shared Admin app from ../src/firebase (emulator when
 * FIRESTORE_EMULATOR_HOST is set, else a real project via
 * GOOGLE_APPLICATION_CREDENTIALS + GCLOUD_PROJECT).
 */

import { db } from "../src/firebase";
import { normalizeEmbedding, TARGET_EMBED_DIM } from "../src/ai";
import { toVector, readEmbedding } from "../src/vector";

const PAGE = 400;

interface Flags {
  commit: boolean;
}

function parseFlags(argv: string[]): Flags {
  return { commit: argv.includes("--commit") };
}

// A doc needs conversion only when its embedding is still a plain JS array.
// Native vector values are objects (with a toArray()), so they are skipped.
function isLegacyArray(value: unknown): value is number[] {
  return Array.isArray(value);
}

async function main(): Promise<void> {
  const { commit } = parseFlags(process.argv.slice(2));
  console.log(`migrate-embeddings: mode = ${commit ? "COMMIT (will rewrite)" : "DRY-RUN (no writes)"}`);
  console.log(`migrate-embeddings: target dimension = ${TARGET_EMBED_DIM}`);

  let scanned = 0;
  let legacy = 0;
  let alreadyVector = 0;
  let converted = 0;
  let skippedNoEmbedding = 0;

  // Page through the whole collection by document id so memory stays bounded.
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection("knowledge_chunks").orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last.id);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    let pending = 0;

    for (const doc of snap.docs) {
      scanned += 1;
      const raw = doc.get("embedding");
      if (raw == null) {
        skippedNoEmbedding += 1;
        continue;
      }
      if (!isLegacyArray(raw)) {
        // Either already a vector value or an unrecognised shape we won't touch.
        if (readEmbedding(raw)) alreadyVector += 1;
        continue;
      }
      legacy += 1;
      if (commit) {
        const normalized = normalizeEmbedding(raw, TARGET_EMBED_DIM);
        batch.update(doc.ref, { embedding: toVector(normalized) });
        pending += 1;
      }
    }

    if (commit && pending > 0) {
      await batch.commit();
      converted += pending;
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  console.log("migrate-embeddings: summary");
  console.log(`  scanned            ${scanned}`);
  console.log(`  already vector     ${alreadyVector}`);
  console.log(`  no embedding       ${skippedNoEmbedding}`);
  console.log(`  legacy arrays      ${legacy}`);
  console.log(`  converted          ${commit ? converted : 0}`);
  if (!commit && legacy > 0) {
    console.log("dry-run: nothing was written. Re-run with --commit to convert.");
  }
}

main().catch((err) => {
  console.error("migrate-embeddings: fatal error", err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
