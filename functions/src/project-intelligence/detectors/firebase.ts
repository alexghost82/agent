import type { ScannedFile } from "../types";

// Firebase-specific detection over the bounded set of files whose content was
// fetched. Pure + deterministic (no I/O) so it is fully unit-testable and never
// sends code to AI. Both detectors are intentionally conservative and bounded.

export interface FirebaseFunctionInfo {
  // Exported symbol name (e.g. "api", "ingestWorker", "scanWorker").
  name: string;
  // Coarse trigger kind, used for the node description.
  kind: "https" | "task" | "schedule" | "trigger" | "callable" | "function";
  // File where the function is defined.
  path: string;
}

export interface FirestoreCollectionInfo {
  name: string;
  // File paths that read from / write to the collection (deduped, bounded).
  readers: string[];
  writers: string[];
}

// Cost guards: keep synthesized nodes/edges small even on large repos.
const MAX_FUNCTIONS = 40;
const MAX_COLLECTIONS = 30;
const MAX_FILES_PER_COLLECTION = 8;

// `export const <name> = on<Trigger>(` — the Cloud Functions v2 definition form.
const FN_RX = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(on[A-Za-z0-9]+)\s*[(<]/g;

function fnKind(trigger: string): FirebaseFunctionInfo["kind"] {
  if (trigger === "onRequest") return "https";
  if (trigger === "onCall") return "callable";
  if (trigger === "onTaskDispatched") return "task";
  if (trigger === "onSchedule") return "schedule";
  if (/^on(Document|Value|Object|Message|Write|Create|Update|Delete)/.test(trigger)) return "trigger";
  return "function";
}

// Detect deployed Cloud Functions from their `export const x = onXxx(` defs.
export function detectFirebaseFunctions(files: ScannedFile[]): FirebaseFunctionInfo[] {
  const out: FirebaseFunctionInfo[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.content) continue;
    if (!/\.[cm]?[jt]sx?$/.test(f.path)) continue;
    FN_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FN_RX.exec(f.content))) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, kind: fnKind(m[2]), path: f.path });
      if (out.length >= MAX_FUNCTIONS) return out;
    }
  }
  return out;
}

// `.collection("name")` / `.collection('name')` references. Matches the common
// firebase-admin / client SDK call shape; ignores dynamic (variable) names.
const COLLECTION_RX = /\.collection\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
// Heuristic: a file that contains any of these is treated as a writer.
const WRITE_RX = /\.(set|add|update|delete|create)\s*\(/;

// Detect Firestore collections referenced from code, attributing each
// referencing file as a reader or writer (coarse, file-level heuristic).
export function detectFirestoreCollections(files: ScannedFile[]): FirestoreCollectionInfo[] {
  const byName = new Map<string, { readers: Set<string>; writers: Set<string> }>();
  for (const f of files) {
    if (!f.content) continue;
    if (!/\.[cm]?[jt]sx?$/.test(f.path)) continue;
    const isWriter = WRITE_RX.test(f.content);
    COLLECTION_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    const localSeen = new Set<string>();
    while ((m = COLLECTION_RX.exec(f.content))) {
      const name = m[1];
      if (localSeen.has(name)) continue;
      localSeen.add(name);
      let entry = byName.get(name);
      if (!entry) {
        if (byName.size >= MAX_COLLECTIONS) continue;
        entry = { readers: new Set(), writers: new Set() };
        byName.set(name, entry);
      }
      if (isWriter) entry.writers.add(f.path);
      else entry.readers.add(f.path);
    }
  }
  return Array.from(byName.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, e]) => ({
      name,
      readers: Array.from(e.readers).slice(0, MAX_FILES_PER_COLLECTION),
      writers: Array.from(e.writers).slice(0, MAX_FILES_PER_COLLECTION)
    }));
}
