/**
 * Seed + cleanup helper for the REAL Firestore vector-search validation
 * (functions/test/integration-real/vector_real.test.ts).
 *
 * Why this exists: the Firestore EMULATOR does NOT implement `findNearest`, so
 * the only way to validate `FirestoreVectorIndex.search` end to end is against a
 * real (test) Firebase project that has the `knowledge_chunks.embedding` vector
 * index deployed. This module seeds a small, deterministic set of
 * `knowledge_chunks` (embeddings stored as native Firestore vector values via
 * `FieldValue.vector`) under a dedicated, throwaway test user namespace, and
 * deletes them again afterwards so we NEVER touch real user data.
 *
 * It is imported by the integration test AND is runnable standalone for manual
 * validation, e.g.:
 *
 *   # seed (uses a generated test userId, printed to stdout)
 *   GHOST_VECTOR_REAL=1 GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
 *     GCLOUD_PROJECT=my-test-project npx tsx scripts/seed-vector-fixtures.ts seed
 *
 *   # seed under an explicit userId
 *   ... npx tsx scripts/seed-vector-fixtures.ts seed ghost_vec_real_manual
 *
 *   # cleanup everything seeded under that userId
 *   ... npx tsx scripts/seed-vector-fixtures.ts cleanup ghost_vec_real_manual
 *
 * It deliberately imports `db` from ../src/firebase (rather than calling
 * admin.initializeApp itself) so it shares a single Admin app with the rest of
 * the suite and never double-initialises.
 */
import * as nodeCrypto from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";

import { db } from "../src/firebase";

// Must match the dimension declared for `knowledge_chunks.embedding` in
// firestore.indexes.json. `findNearest` rejects a query vector whose dimension
// differs from the indexed field, so the fixtures and the query MUST use this.
export const EMBED_DIM = 1536;

// Collection under validation.
export const COLLECTION = "knowledge_chunks";

// All seeded docs live under a userId starting with this prefix so cleanup can
// target ONLY synthetic data and never collide with a real user.
export const TEST_USER_PREFIX = "ghost_vec_real_";

export interface VectorFixture {
  /** Stable, human-readable label used by the test to assert ordering. */
  title: string;
  content: string;
  /** Dense embedding of length EMBED_DIM, stored as a Firestore vector value. */
  embedding: number[];
  scope?: string;
}

/**
 * Builds a length-`dim` "axis" vector: `weight` on a single component, zeros
 * elsewhere. Axis vectors are mutually orthogonal, which makes the cosine
 * ordering against a chosen query vector exactly predictable.
 */
export function axisVector(axis: number, weight = 1, dim = EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  v[axis] = weight;
  return v;
}

/**
 * Three orthogonal fixtures ("near"/"mid"/"far") on axes 0/1/2. Paired with a
 * query vector that leans mostly on axis 0 and a little on axis 1 (see the
 * test / `queryVector` below), the expected cosine ordering is near > mid > far.
 */
export function defaultFixtures(): VectorFixture[] {
  return [
    { title: "near", content: "near chunk", scope: "topic", embedding: axisVector(0) },
    { title: "mid", content: "mid chunk", scope: "topic", embedding: axisVector(1) },
    { title: "far", content: "far chunk", scope: "topic", embedding: axisVector(2) }
  ];
}

/**
 * Query vector matching `defaultFixtures`: dominant on axis 0, smaller on axis
 * 1, nothing on axis 2 -> cosine(near) > cosine(mid) > cosine(far). Exported so
 * the test can feed it through the (mocked) embedding seam deterministically.
 */
export function queryVector(): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  v[0] = 0.96;
  v[1] = 0.28;
  return v;
}

/** Generates a fresh, collision-resistant test userId in the safe namespace. */
export function makeTestUserId(): string {
  return `${TEST_USER_PREFIX}${Date.now().toString(36)}_${nodeCrypto.randomBytes(4).toString("hex")}`;
}

function assertTestUser(userId: string): void {
  if (!userId.startsWith(TEST_USER_PREFIX)) {
    throw new Error(
      `refusing to operate on userId "${userId}": vector fixtures may only be ` +
        `seeded/cleaned under the "${TEST_USER_PREFIX}" test namespace`
    );
  }
}

/**
 * Seeds the given fixtures as `knowledge_chunks` for `userId`. Embeddings are
 * written as native Firestore vector values (`FieldValue.vector`) so that the
 * deployed vector index covers them and `findNearest` can rank them. Returns the
 * created document ids (in fixture order).
 */
export async function seedVectorFixtures(
  userId: string,
  fixtures: VectorFixture[] = defaultFixtures()
): Promise<string[]> {
  assertTestUser(userId);
  const ids: string[] = [];
  const batch = db.batch();
  for (const f of fixtures) {
    if (f.embedding.length !== EMBED_DIM) {
      throw new Error(`fixture "${f.title}" has dim ${f.embedding.length}, expected ${EMBED_DIM}`);
    }
    const ref = db.collection(COLLECTION).doc();
    batch.set(ref, {
      userId,
      scope: f.scope ?? "topic",
      title: f.title,
      content: f.content,
      // Store as a Firestore vector value so the deployed vector index applies.
      embedding: FieldValue.vector(f.embedding),
      contentHash: nodeCrypto.createHash("sha256").update(`${userId}:${f.title}`).digest("hex"),
      createdAt: FieldValue.serverTimestamp()
    });
    ids.push(ref.id);
  }
  await batch.commit();
  return ids;
}

/**
 * Deletes EVERY `knowledge_chunks` doc owned by `userId`. Guarded to the test
 * namespace so it can never wipe real user data. Returns the number deleted.
 */
export async function cleanupVectorFixtures(userId: string): Promise<number> {
  assertTestUser(userId);
  let deleted = 0;
  // Page through in batches in case a manual run left a larger set behind.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await db.collection(COLLECTION).where("userId", "==", userId).limit(300).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 300) break;
  }
  return deleted;
}

/* -------------------------------------------------------------------------- */
/* Standalone CLI (manual validation)                                         */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const [, , cmd, userArg] = process.argv;
  if (cmd === "seed") {
    const userId = userArg || makeTestUserId();
    const ids = await seedVectorFixtures(userId);
    process.stdout.write(`seeded ${ids.length} chunks for userId=${userId}\n`);
    process.stdout.write(`ids=${ids.join(",")}\n`);
    process.stdout.write(`cleanup with: npx tsx scripts/seed-vector-fixtures.ts cleanup ${userId}\n`);
  } else if (cmd === "cleanup") {
    if (!userArg) throw new Error("usage: cleanup <userId>");
    const n = await cleanupVectorFixtures(userArg);
    process.stdout.write(`deleted ${n} chunks for userId=${userArg}\n`);
  } else {
    process.stdout.write(
      "usage: tsx scripts/seed-vector-fixtures.ts <seed [userId] | cleanup <userId>>\n"
    );
    process.exitCode = 2;
  }
}

// Run only when invoked directly (tsx/ts-node/node), never when imported by the
// test. Avoids `import.meta` so it also compiles cleanly under CommonJS.
const invokedDirectly = !!process.argv[1] && /seed-vector-fixtures(\.[tj]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
      process.exit(1);
    });
}
