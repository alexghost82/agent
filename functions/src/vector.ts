import { FieldValue } from "firebase-admin/firestore";

// Embedding storage seam (CONTRACT v3.2 follow-up). Firestore Vector Search
// (`findNearest`) only matches documents whose `embedding` field is stored as a
// native Firestore *vector value*, not a plain `number[]` array. Historically we
// wrote plain arrays, so the firestore backend matched nothing and retrieval had
// to fall back to in-memory cosine. These helpers make every write store a real
// vector value and every read tolerant of BOTH representations so legacy rows
// (plain arrays) keep working until they are wiped/backfilled.

// Wrap a numeric embedding as a Firestore vector value for storage.
export function toVector(embedding: number[]): FirebaseFirestore.VectorValue {
  return FieldValue.vector(embedding);
}

// Read an embedding back as a plain number[] regardless of how it was stored:
//   - native Firestore vector value → has `.toArray()`
//   - legacy plain array            → returned as-is
// Returns undefined when the field is missing/unrecognised so callers can skip.
export function readEmbedding(value: unknown): number[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value as number[];
  const maybe = value as { toArray?: () => number[] };
  if (typeof maybe.toArray === "function") {
    try {
      return maybe.toArray();
    } catch {
      return undefined;
    }
  }
  return undefined;
}
