import { db } from "./firebase";
import { embedding } from "./ai";
import { cosineSimilarity, selectVectorBackend } from "./pure";
import { log } from "./log";

export interface SearchScope {
  userId: string;
  topicId?: string;
  projectId?: string;
}

export interface ScoredChunk {
  id: string;
  sourceUrl?: string;
  sourcePath?: string;
  title?: string;
  content: string;
  chunkType?: string;
  scope?: string;
  score: number;
}

// Vector search behind an interface so the backing store can change without
// touching callers. The current implementation scores candidates in-process;
// per ADR a Firestore Vector Search / external index can be dropped in here.
export interface VectorIndex {
  search(query: string, scope: SearchScope, limit: number): Promise<ScoredChunk[]>;
}

// Hard cap on candidates pulled into memory for in-process scoring. Configurable
// so it can be tightened on large corpora; recall above this cap is best-effort.
function candidateCap(): number {
  const n = Number(process.env.VECTOR_CANDIDATE_CAP);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

export class InMemoryCosineIndex implements VectorIndex {
  async search(query: string, scope: SearchScope, limit: number): Promise<ScoredChunk[]> {
    const qEmbedding = await embedding(query, scope.userId);
    return this.searchWithEmbedding(qEmbedding, scope, limit);
  }

  // Scores candidates against an already-computed query embedding. Split out so
  // callers that already have the query vector (e.g. the Firestore backend's
  // runtime fallback) don't pay for a second embedding round-trip.
  async searchWithEmbedding(
    qEmbedding: number[],
    scope: SearchScope,
    limit: number
  ): Promise<ScoredChunk[]> {
    let q: FirebaseFirestore.Query = db.collection("knowledge_chunks").where("userId", "==", scope.userId);
    if (scope.topicId) q = q.where("topicId", "==", scope.topicId);
    if (scope.projectId) q = q.where("projectId", "==", scope.projectId);

    const cap = candidateCap();
    const snap = await q.limit(cap).get();
    if (snap.size >= cap) {
      log("warn", "vector_candidate_cap_hit", { userId: scope.userId, cap });
    }
    const scored = snap.docs.map((doc) => {
      const data = doc.data();
      const emb = data.embedding as number[] | undefined;
      return {
        id: doc.id,
        sourceUrl: data.sourceUrl,
        sourcePath: data.sourcePath,
        title: data.title,
        content: data.content,
        chunkType: data.chunkType,
        scope: data.scope,
        score: emb ? cosineSimilarity(qEmbedding, emb) : 0
      };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// Field that `findNearest` writes the computed distance into for each returned
// doc. Must not collide with a real chunk field; `vector_distance` is the name
// used in the Firestore docs and is safe (not a reserved `__…__` field).
const DISTANCE_FIELD = "vector_distance";

// True when running against the Firestore emulator, which does NOT implement
// `findNearest`. We detect either the Functions emulator marker or an explicit
// emulator host so the in-memory cosine path is selected automatically.
export function isEmulator(): boolean {
  return !!(process.env.FUNCTIONS_EMULATOR || process.env.FIRESTORE_EMULATOR_HOST);
}

// Firestore Vector Search backend (CONTRACT v3.2). Now the DEFAULT backend in
// real runtimes (see `selectVectorBackend`). Uses `findNearest`, so recall is
// NOT bounded by VECTOR_CANDIDATE_CAP. Requires the `embedding` vector field
// override in firestore.indexes.json and embeddings stored as Firestore vector
// values. The Firestore emulator lacks findNearest, so it is never auto-selected
// there; if a findNearest query still throws at runtime (index not ready /
// unsupported) we fall back to the in-memory cosine path for that request so
// retrieval never hard-fails.
export class FirestoreVectorIndex implements VectorIndex {
  private readonly fallback = new InMemoryCosineIndex();

  // Seam: embeds the query string. Isolated so tests can drive the fallback
  // logic deterministically without a live embedding provider.
  protected embedQuery(query: string, userId: string): Promise<number[]> {
    return embedding(query, userId);
  }

  // Seam: the actual vector query. Isolated so tests can simulate a findNearest
  // failure (index not ready / emulator) and assert the fallback path.
  protected async runFindNearest(
    qEmbedding: number[],
    scope: SearchScope,
    limit: number
  ): Promise<ScoredChunk[]> {
    let q: FirebaseFirestore.Query = db.collection("knowledge_chunks").where("userId", "==", scope.userId);
    if (scope.topicId) q = q.where("topicId", "==", scope.topicId);
    if (scope.projectId) q = q.where("projectId", "==", scope.projectId);

    // `findNearest` is available on the Admin SDK Query; cast keeps this
    // compiling across SDK minor versions without pinning the vector types.
    // `distanceResultField` makes the SDK surface the COSINE distance per doc.
    const vectorQuery = (q as unknown as {
      findNearest(opts: {
        vectorField: string;
        queryVector: number[];
        limit: number;
        distanceMeasure: "COSINE";
        distanceResultField?: string;
      }): FirebaseFirestore.Query;
    }).findNearest({
      vectorField: "embedding",
      queryVector: qEmbedding,
      limit,
      distanceMeasure: "COSINE",
      distanceResultField: DISTANCE_FIELD
    });

    const snap = await vectorQuery.get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      const distance = data[DISTANCE_FIELD];
      return {
        id: doc.id,
        sourceUrl: data.sourceUrl,
        sourcePath: data.sourcePath,
        title: data.title,
        content: data.content,
        chunkType: data.chunkType,
        scope: data.scope,
        // Firestore COSINE distance ∈ [0,2]; similarity = 1 - distance preserves
        // the same "higher = closer" ordering as InMemoryCosineIndex. When the
        // SDK does not surface a distance we fall back to a neutral 0 score and
        // rely on retrieval order.
        score: typeof distance === "number" ? 1 - distance : 0
      };
    });
  }

  async search(query: string, scope: SearchScope, limit: number): Promise<ScoredChunk[]> {
    const qEmbedding = await this.embedQuery(query, scope.userId);
    try {
      return await this.runFindNearest(qEmbedding, scope, limit);
    } catch (err) {
      // Graceful per-request degradation: index not ready, unsupported, or a
      // transient vector-query error must not hard-fail retrieval.
      log("warn", "vector_findnearest_fallback_inmemory", {
        userId: scope.userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return this.fallback.searchWithEmbedding(qEmbedding, scope, limit);
    }
  }
}

// Picks the backend per the (now firestore-default) selection policy, with the
// emulator auto-falling back to the in-memory cosine index.
export function makeIndex(): VectorIndex {
  const backend = selectVectorBackend(process.env.VECTOR_BACKEND, { emulator: isEmulator() });
  log("info", "vector_backend_selected", { backend, emulator: isEmulator() });
  return backend === "firestore" ? new FirestoreVectorIndex() : new InMemoryCosineIndex();
}

const index: VectorIndex = makeIndex();

// Always scoped to a single user (data isolation). Optionally narrowed to a
// topic or project to keep the candidate set small.
export async function searchMemory(query: string, scope: SearchScope, limit = 8): Promise<ScoredChunk[]> {
  return index.search(query, scope, limit);
}

export interface GatherContextOpts {
  // Per-subquery retrieval limit passed to `searchMemory`.
  perQuery?: number;
  // Hard cap on the number of merged chunks returned.
  maxChunks?: number;
  // Total character budget across the returned chunks' `content`. Once the
  // budget is exhausted the remaining (lowest-priority) chunks are dropped.
  charBudget?: number;
}

// Pure merge/rank/budget step for a set of already-retrieved candidate chunks
// (Epic 2.1). Kept side-effect free so it is unit-testable without Firestore:
//   1. dedup by `id` (keeping the highest score seen for an id),
//   2. promote `chunkType==="summary"` chunks to the front (resource summaries
//      are the most valuable "understanding" we have), each group sorted by
//      score desc,
//   3. cap to `maxChunks` and to a cumulative `charBudget`, dropping the tail.
export function mergeContext(
  results: ScoredChunk[],
  opts?: { maxChunks?: number; charBudget?: number }
): ScoredChunk[] {
  const maxChunks = opts?.maxChunks ?? 40;
  const charBudget = opts?.charBudget ?? 16000;

  const byId = new Map<string, ScoredChunk>();
  for (const c of results) {
    if (!c || !c.id) continue;
    const prev = byId.get(c.id);
    if (!prev || c.score > prev.score) byId.set(c.id, c);
  }

  const merged = [...byId.values()];
  const summaries = merged.filter((c) => c.chunkType === "summary").sort((a, b) => b.score - a.score);
  const rest = merged.filter((c) => c.chunkType !== "summary").sort((a, b) => b.score - a.score);
  const ordered = [...summaries, ...rest];

  const out: ScoredChunk[] = [];
  let used = 0;
  for (const c of ordered) {
    if (out.length >= maxChunks) break;
    const len = (c.content || "").length;
    // Always allow at least one chunk through even if it alone exceeds the
    // budget, so a single large summary is never silently dropped.
    if (out.length > 0 && used + len > charBudget) continue;
    out.push(c);
    used += len;
  }
  return out;
}

// Retrieve and merge context for one or more subqueries (Epic 2.1). Runs each
// subquery through `searchMemory` (sequentially, to bound peak memory), then
// merges/ranks/budgets the union via `mergeContext`. Summary chunks float to the
// top; output is bounded by `maxChunks` and `charBudget`.
export async function gatherContext(
  queries: string[] | string,
  scope: SearchScope,
  opts?: GatherContextOpts
): Promise<ScoredChunk[]> {
  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q) => (q || "").trim())
    .filter(Boolean);
  if (!list.length) return [];

  const perQuery = opts?.perQuery ?? 8;
  // Run subqueries SEQUENTIALLY, not with Promise.all. The in-memory backend
  // loads every candidate chunk (each with a large embedding vector) into memory
  // to score it; running all subqueries in parallel keeps N candidate sets alive
  // at once and caused OOM crashes (JS heap exhausted) on bigger topics. Doing
  // them one at a time keeps only a single candidate set live, so each is GC'd
  // before the next — peak memory drops ~Nx for a small latency cost. Each
  // searchMemory only returns its top `perQuery` scored chunks, so the merged
  // result is unchanged.
  const batches: ScoredChunk[][] = [];
  for (const q of list) {
    batches.push(await searchMemory(q, scope, perQuery));
  }
  return mergeContext(batches.flat(), { maxChunks: opts?.maxChunks, charBudget: opts?.charBudget });
}
