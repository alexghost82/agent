import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { tsMillis } from "./pure";
import { badRequest } from "./errors";
import { log } from "./log";

export interface ListOptions {
  collection: string;
  userId: string;
  // Additional equality filters (e.g. topicId, projectId).
  where?: [field: string, value: unknown][];
  orderField?: string;
  limit?: number;
}

export interface ListedDoc {
  id: string;
  [key: string]: unknown;
}

// Cursor pagination options. `cursor` is the opaque token returned as
// `nextCursor` from the previous page; `pageSize` bounds the page (falls back to
// `limit`, then to DEFAULT_PAGE_SIZE).
export interface ListPageOptions extends ListOptions {
  cursor?: string | null;
  pageSize?: number;
}

export interface ListPage {
  items: ListedDoc[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
// Upper bound on docs scanned in the index-missing fallback path. Cursor paging
// there is best-effort and only correct within this newest-N window (see below).
const FALLBACK_SCAN_LIMIT = 1000;

function clampPageSize(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(n)));
}

function buildScopedQuery(opts: ListOptions): FirebaseFirestore.Query {
  let base: FirebaseFirestore.Query = db.collection(opts.collection).where("userId", "==", opts.userId);
  for (const [field, value] of opts.where ?? []) base = base.where(field, "==", value);
  return base;
}

/* -------------------------------------------------------------------------- */
/* Opaque cursor encode / decode (pure — unit tested in test/listing.test.ts)  */
/* -------------------------------------------------------------------------- */

// A small, JSON-serializable representation of an orderBy value. Firestore
// Timestamps are encoded with full second+nanosecond precision so the cursor
// reconstructs the exact stored value (no off-by-a-tick skips/dupes).
type SerializedValue =
  | { k: "ts"; s: number; n: number }
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" };

export interface DecodedCursor {
  orderValue: unknown;
  docId: string;
}

function timestampParts(v: unknown): { seconds: number; nanoseconds: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o._seconds === "number") {
    return { seconds: o._seconds, nanoseconds: typeof o._nanoseconds === "number" ? o._nanoseconds : 0 };
  }
  if (typeof o.seconds === "number") {
    return { seconds: o.seconds, nanoseconds: typeof o.nanoseconds === "number" ? o.nanoseconds : 0 };
  }
  if (v instanceof Date) {
    const ms = v.getTime();
    return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
  }
  if (typeof o.toMillis === "function") {
    const ms = (o.toMillis as () => number)();
    return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
  }
  return null;
}

function serializeOrderValue(value: unknown): SerializedValue {
  if (value === null || value === undefined) return { k: "null" };
  const ts = timestampParts(value);
  if (ts) return { k: "ts", s: ts.seconds, n: ts.nanoseconds };
  if (typeof value === "number") return { k: "num", v: value };
  if (typeof value === "boolean") return { k: "bool", v: value };
  if (typeof value === "string") return { k: "str", v: value };
  // Best-effort fallback for exotic values: stringify so the cursor is still
  // stable (ordering against Firestore is undefined for these, but createdAt —
  // the only orderField in use — is always a Timestamp).
  return { k: "str", v: String(value) };
}

function isSerializedValue(o: unknown): o is SerializedValue {
  if (!o || typeof o !== "object") return false;
  const k = (o as { k?: unknown }).k;
  const v = (o as { v?: unknown });
  switch (k) {
    case "ts":
      return typeof (o as { s?: unknown }).s === "number" && typeof (o as { n?: unknown }).n === "number";
    case "num":
      return typeof v.v === "number";
    case "str":
      return typeof v.v === "string";
    case "bool":
      return typeof v.v === "boolean";
    case "null":
      return true;
    default:
      return false;
  }
}

function deserializeOrderValue(s: SerializedValue): unknown {
  switch (s.k) {
    case "ts":
      return new Timestamp(s.s, s.n);
    case "num":
      return s.v;
    case "str":
      return s.v;
    case "bool":
      return s.v;
    case "null":
      return null;
  }
}

// Encode the last doc's orderField value + id into an opaque base64url token.
export function encodeCursor(orderValue: unknown, docId: string): string {
  const payload = { o: serializeOrderValue(orderValue), i: docId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// Decode an opaque cursor. Returns null (never throws) for any malformed input
// so callers can decide whether to ignore or reject it.
export function decodeCursor(raw: unknown): DecodedCursor | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = (parsed as { o?: unknown }).o;
    const i = (parsed as { i?: unknown }).i;
    if (typeof i !== "string" || i.length === 0) return null;
    if (!isSerializedValue(o)) return null;
    return { orderValue: deserializeOrderValue(o), docId: i };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Keyset ordering helpers (pure — used by the index-missing fallback)         */
/* -------------------------------------------------------------------------- */

// Compare two orderField values for a DESCENDING sort (newest first). Mirrors
// the index path's `orderBy(field, "desc")`. Timestamp-like values compare by
// millis; otherwise numeric, then lexicographic.
export function compareOrderValuesDesc(a: unknown, b: unknown): number {
  const am = tsMillis(a);
  const bm = tsMillis(b);
  if (am !== 0 || bm !== 0) return bm - am;
  if (typeof a === "number" && typeof b === "number") return b - a;
  const as = a == null ? "" : String(a);
  const bs = b == null ? "" : String(b);
  if (as < bs) return 1;
  if (as > bs) return -1;
  return 0;
}

// Full keyset comparator: orderField DESC, then document id DESC. This matches
// Firestore's implicit `__name__ DESC` tie-break for a `desc` orderBy, so the
// fallback orders pages identically to the indexed path.
export function compareKeysetDesc(
  a: { value: unknown; id: string },
  b: { value: unknown; id: string }
): number {
  const c = compareOrderValuesDesc(a.value, b.value);
  if (c !== 0) return c;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                     */
/* -------------------------------------------------------------------------- */

// Shared "scope to user → order → limit" reader. Relies on the composite
// indexes from contract §1 (userId == + <field> == + createdAt desc). If an
// index is not yet deployed, it degrades gracefully to an unordered fetch +
// in-memory sort so the endpoint keeps working during the index rollout.
//
// Backward-compatible: returns the bare `ListedDoc[]`. For offset-free,
// cursor-based paging over large datasets use `listScopedPage` instead.
export async function listScoped(opts: ListOptions): Promise<ListedDoc[]> {
  const orderField = opts.orderField ?? "createdAt";
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const base = buildScopedQuery(opts);

  try {
    const snap = await base.orderBy(orderField, "desc").limit(limit).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // FAILED_PRECONDITION = composite index missing. Fall back so the API stays
    // up while Architect's indexes propagate; log once so it is observable.
    const code = (err as { code?: number | string })?.code;
    if (code === 9 || code === "failed-precondition") {
      log("warn", "list_index_fallback", { collection: opts.collection, orderField });
      const snap = await base.limit(limit).get();
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => tsMillis((b as Record<string, unknown>)[orderField]) - tsMillis((a as Record<string, unknown>)[orderField]));
    }
    throw err;
  }
}

// Cursor-based (keyset) pagination over the same scoped query. Offset-free: each
// page is fetched with `startAfter(orderValue, id)` on `(orderField desc,
// __name__ desc)`, so cost is independent of how deep the page is. Tie-breaking
// by document id guarantees pages never skip or duplicate when many docs share
// the same orderField value. Returns `{ items, nextCursor }`; `nextCursor` is
// null once the result set is exhausted.
//
// Malformed `cursor` → throws `badRequest` (HTTP 400 `bad_request`) so callers
// get a clean error rather than a silently wrong page.
//
// Index-missing fallback: keyset paging needs the composite index. If it is
// missing we degrade to a bounded unordered scan (FALLBACK_SCAN_LIMIT) sorted
// in memory; paging is then only correct within that newest-N window. This is a
// temporary degradation for the index-rollout window, mirroring `listScoped`.
export async function listScopedPage(opts: ListPageOptions): Promise<ListPage> {
  const orderField = opts.orderField ?? "createdAt";
  const pageSize = clampPageSize(opts.pageSize ?? opts.limit);
  const base = buildScopedQuery(opts);

  let decoded: DecodedCursor | null = null;
  if (opts.cursor != null && opts.cursor !== "") {
    decoded = decodeCursor(opts.cursor);
    if (!decoded) throw badRequest("invalid_cursor");
  }

  try {
    let q = base.orderBy(orderField, "desc").orderBy(FieldPath.documentId(), "desc");
    if (decoded) q = q.startAfter(decoded.orderValue, decoded.docId);
    const snap = await q.limit(pageSize).get();

    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    let nextCursor: string | null = null;
    if (snap.docs.length === pageSize && pageSize > 0) {
      const last = snap.docs[snap.docs.length - 1];
      nextCursor = encodeCursor(last.get(orderField), last.id);
    }
    return { items, nextCursor };
  } catch (err) {
    const code = (err as { code?: number | string })?.code;
    if (code === 9 || code === "failed-precondition") {
      log("warn", "list_page_index_fallback", { collection: opts.collection, orderField });
      return fallbackPage(base, orderField, pageSize, decoded);
    }
    throw err;
  }
}

// Best-effort, index-free paging: scan a bounded newest-N window, sort by the
// keyset order, drop everything up to/including the cursor, then slice a page.
async function fallbackPage(
  base: FirebaseFirestore.Query,
  orderField: string,
  pageSize: number,
  decoded: DecodedCursor | null
): Promise<ListPage> {
  const snap = await base.limit(FALLBACK_SCAN_LIMIT).get();
  const rows = snap.docs
    .map((d) => ({ id: d.id, value: d.get(orderField) as unknown, data: d.data() }))
    .sort((a, b) => compareKeysetDesc(a, b));

  let start = 0;
  if (decoded) {
    const cursorKey = { value: decoded.orderValue, id: decoded.docId };
    // Keep only rows strictly after the cursor in keyset order.
    start = rows.findIndex((r) => compareKeysetDesc(cursorKey, r) < 0);
    if (start === -1) start = rows.length;
  }

  const slice = rows.slice(start, start + pageSize);
  const hasMore = rows.length > start + pageSize;
  const nextCursor =
    hasMore && slice.length > 0
      ? encodeCursor(slice[slice.length - 1].value, slice[slice.length - 1].id)
      : null;

  return { items: slice.map((r) => ({ id: r.id, ...r.data })), nextCursor };
}
