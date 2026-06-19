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

class InMemoryCosineIndex implements VectorIndex {
  async search(query: string, scope: SearchScope, limit: number): Promise<ScoredChunk[]> {
    const qEmbedding = await embedding(query, scope.userId);
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

// Firestore Vector Search backend (CONTRACT v3.2). Selected with
// VECTOR_BACKEND="firestore". Uses `findNearest`, so recall is NOT bounded by
// VECTOR_CANDIDATE_CAP. Requires the `embedding` vector field override in
// firestore.indexes.json and embeddings stored as Firestore vector values.
// Not exercised by the Firestore emulator (which lacks findNearest); the
// in-memory backend remains the default and the tested path.
class FirestoreVectorIndex implements VectorIndex {
  async search(query: string, scope: SearchScope, limit: number): Promise<ScoredChunk[]> {
    const qEmbedding = await embedding(query, scope.userId);
    let q: FirebaseFirestore.Query = db.collection("knowledge_chunks").where("userId", "==", scope.userId);
    if (scope.topicId) q = q.where("topicId", "==", scope.topicId);
    if (scope.projectId) q = q.where("projectId", "==", scope.projectId);

    // `findNearest` is available on the Admin SDK Query; cast keeps this
    // compiling across SDK minor versions without pinning the vector types.
    const vectorQuery = (q as unknown as {
      findNearest(opts: { vectorField: string; queryVector: number[]; limit: number; distanceMeasure: "COSINE" }): FirebaseFirestore.Query;
    }).findNearest({ vectorField: "embedding", queryVector: qEmbedding, limit, distanceMeasure: "COSINE" });

    const snap = await vectorQuery.get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        sourceUrl: data.sourceUrl,
        sourcePath: data.sourcePath,
        title: data.title,
        content: data.content,
        chunkType: data.chunkType,
        scope: data.scope,
        // Distance is not returned uniformly across SDK versions; expose 0 as a
        // neutral score since callers rank by retrieval order here.
        score: 0
      };
    });
  }
}

function makeIndex(): VectorIndex {
  return selectVectorBackend(process.env.VECTOR_BACKEND) === "firestore"
    ? new FirestoreVectorIndex()
    : new InMemoryCosineIndex();
}

const index: VectorIndex = makeIndex();

// Always scoped to a single user (data isolation). Optionally narrowed to a
// topic or project to keep the candidate set small.
export async function searchMemory(query: string, scope: SearchScope, limit = 8): Promise<ScoredChunk[]> {
  return index.search(query, scope, limit);
}
