/**
 * REAL Firestore Vector Search validation (feature/firestore-validation).
 *
 * WHY A SEPARATE "integration-real" SUITE:
 *   The Firestore EMULATOR does NOT implement `findNearest`, so the emulator
 *   integration suite (test/integration/vector_backend.test.ts) can only assert
 *   the *fallback* path. The actual `FirestoreVectorIndex.search` ->
 *   `findNearest(vectorField:'embedding', queryVector, limit, COSINE)` query can
 *   only be exercised against a REAL (test) Firebase project that has the
 *   `knowledge_chunks.embedding` vector index deployed.
 *
 * GATING (never breaks normal CI):
 *   This suite self-skips unless it is explicitly pointed at a real test project
 *   via `GHOST_VECTOR_REAL=1` AND real-project credentials/project id are present
 *   (`GOOGLE_APPLICATION_CREDENTIALS` / `GCLOUD_PROJECT` / `FIREBASE_PROJECT` /
 *   `GOOGLE_CLOUD_PROJECT`). It also refuses to run if a Firestore emulator host
 *   is configured, because the emulator cannot validate `findNearest`. So the
 *   default `npm test` (and the emulator CI job) simply skip it.
 *
 * DATA SAFETY:
 *   All data is seeded under a dedicated, throwaway `ghost_vec_real_*` userId and
 *   deleted in `afterAll`. We never read or write real user data. Embeddings are
 *   deterministic synthetic vectors; the embedding *provider* is mocked so the
 *   query vector is fixed and the test needs no paid embedding API key — only the
 *   REAL `findNearest` query path is exercised against live Firestore.
 *
 * To keep the skipped run side-effect free, ALL `src/**` and seed-helper imports
 * are dynamic and happen inside `beforeAll`, which does not run when skipped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Type-only `import(...)` aliases: fully erased, so they never load src/** at
// runtime (which would defeat the side-effect-free skip).
type SearchMemoryFn = typeof import("../../src/memory")["searchMemory"];
type CleanupFn = typeof import("../../scripts/seed-vector-fixtures")["cleanupVectorFixtures"];

// Only run against an explicitly designated real test project, and never under
// the emulator (which lacks findNearest).
const REAL_PROJECT =
  !!(
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  ) && !process.env.FIRESTORE_EMULATOR_HOST;
const RUN_REAL = process.env.GHOST_VECTOR_REAL === "1" && REAL_PROJECT;

// Deterministic query vector for the mocked embedding seam. `vi.hoisted` makes
// it available to the (hoisted) vi.mock factory below. It matches the orthogonal
// "near/mid/far" fixtures so the expected cosine order is near > mid > far.
const { QUERY_VECTOR } = vi.hoisted(() => {
  const dim = 1536;
  const v = new Array<number>(dim).fill(0);
  v[0] = 0.96;
  v[1] = 0.28;
  return { QUERY_VECTOR: v };
});

// Mock ONLY the embedding provider so the query embedding is deterministic and
// free. The real Firestore `findNearest` query is NOT mocked — that is exactly
// what this suite validates.
vi.mock("../../src/ai", () => ({
  embedding: vi.fn(async () => QUERY_VECTOR),
  embeddingBatch: vi.fn(async (inputs: string[]) => inputs.map(() => QUERY_VECTOR))
}));

describe.skipIf(!RUN_REAL)("REAL Firestore vector search (findNearest)", () => {
  // Dedicated throwaway namespace; populated in beforeAll.
  let userId: string;
  let searchMemory: SearchMemoryFn;
  let cleanupVectorFixtures: CleanupFn;

  beforeAll(async () => {
    // Force the Firestore backend BEFORE memory.ts is imported (makeIndex reads
    // VECTOR_BACKEND at module-load time). Done here, pre dynamic-import.
    process.env.VECTOR_BACKEND = "firestore";
    // Normalise the project id so Admin init has one when only FIREBASE_PROJECT
    // is provided. We do NOT inject a fake default — a real project is required.
    if (!process.env.GCLOUD_PROJECT) {
      const p = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT;
      if (p) process.env.GCLOUD_PROJECT = p;
    }

    // Dynamic imports: these initialise firebase-admin and build the vector
    // index singleton. Kept out of static scope so a skipped run touches nothing.
    const seed = await import("../../scripts/seed-vector-fixtures");
    const memory = await import("../../src/memory");
    searchMemory = memory.searchMemory;
    cleanupVectorFixtures = seed.cleanupVectorFixtures;

    userId = seed.makeTestUserId();
    await seed.seedVectorFixtures(userId, seed.defaultFixtures());
  }, 60_000);

  afterAll(async () => {
    if (cleanupVectorFixtures && userId) {
      await cleanupVectorFixtures(userId);
    }
  }, 60_000);

  it("ranks nearest neighbours by cosine via a live findNearest query", async () => {
    // Vector indexing on a real project is eventually consistent right after a
    // write, so poll briefly until all three fixtures are visible to findNearest.
    let results: Awaited<ReturnType<SearchMemoryFn>> = [];
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      results = await searchMemory("deterministic-query-embedding-is-mocked", { userId }, 3);
      if (results.length >= 3) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    expect(results.length).toBe(3);
    // The core assertion: cosine nearest-neighbour ordering from REAL findNearest.
    expect(results.map((r) => r.title)).toEqual(["near", "mid", "far"]);
    // Scores are similarity (1 - COSINE distance) and must be strictly decreasing.
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });
});
