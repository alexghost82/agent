import { db } from "./firebase";
import { embedding } from "./ai";
import { cosineSimilarity } from "./pure";

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

// In-memory cosine search, always scoped to a single user (data isolation).
// Optionally narrowed to a topic or project to keep the candidate set small.
export async function searchMemory(query: string, scope: SearchScope, limit = 8): Promise<ScoredChunk[]> {
  const qEmbedding = await embedding(query);
  let q: FirebaseFirestore.Query = db.collection("knowledge_chunks").where("userId", "==", scope.userId);
  if (scope.topicId) q = q.where("topicId", "==", scope.topicId);
  if (scope.projectId) q = q.where("projectId", "==", scope.projectId);
  const snap = await q.limit(1500).get();
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
