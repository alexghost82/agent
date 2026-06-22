import "./helpers/env"; // MUST be first: primes GCLOUD_PROJECT before src/firebase init.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

import {
  encodeCursor,
  decodeCursor,
  compareOrderValuesDesc,
  compareKeysetDesc,
  listScopedPage,
  type DecodedCursor
} from "../src/listing";
import {
  EMULATOR_AVAILABLE,
  db,
  startServer,
  seedUser,
  uid,
  type TestServer
} from "./helpers/harness";

/* -------------------------------------------------------------------------- */
/* Pure: cursor encode / decode / validation                                  */
/* -------------------------------------------------------------------------- */

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a Firestore Timestamp with full nanosecond precision", () => {
    const ts = new Timestamp(1_700_000_123, 456_000_789);
    const decoded = decodeCursor(encodeCursor(ts, "doc_1")) as DecodedCursor;
    expect(decoded).not.toBeNull();
    expect(decoded.docId).toBe("doc_1");
    const back = decoded.orderValue as Timestamp;
    expect(back.seconds).toBe(1_700_000_123);
    expect(back.nanoseconds).toBe(456_000_789);
  });

  it("round-trips numbers, strings, booleans and null order values", () => {
    const num = decodeCursor(encodeCursor(42, "n"))!;
    expect(num.orderValue).toBe(42);
    expect(num.docId).toBe("n");

    const str = decodeCursor(encodeCursor("zeta", "s"))!;
    expect(str.orderValue).toBe("zeta");

    const bool = decodeCursor(encodeCursor(true, "b"))!;
    expect(bool.orderValue).toBe(true);

    const nul = decodeCursor(encodeCursor(null, "z"))!;
    expect(nul.orderValue).toBeNull();
    expect(nul.docId).toBe("z");
  });

  it("treats a Date order value as a Timestamp", () => {
    const d = new Date("2026-01-02T03:04:05.678Z");
    const decoded = decodeCursor(encodeCursor(d, "d"))!;
    const back = decoded.orderValue as Timestamp;
    expect(back.toDate().getTime()).toBe(d.getTime());
  });

  it("produces an opaque token (no readable id / field leak)", () => {
    const token = encodeCursor(new Timestamp(1, 0), "secret_doc_id");
    expect(token).not.toContain("secret_doc_id");
    expect(token).not.toContain("createdAt");
  });

  it("returns null for malformed cursors instead of throwing", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!not base64!!!")).toBeNull();
    expect(decodeCursor("////")).toBeNull();
    // valid base64url of a non-JSON / wrong-shape payload
    expect(decodeCursor(Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ o: { k: "ts", s: 1, n: 0 } }), "utf8").toString("base64url"))).toBeNull(); // missing id
    expect(decodeCursor(Buffer.from(JSON.stringify({ i: "x" }), "utf8").toString("base64url"))).toBeNull(); // missing/invalid o
    expect(decodeCursor(Buffer.from(JSON.stringify({ o: { k: "weird" }, i: "x" }), "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(123 as unknown)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Pure: keyset ordering + tie-break                                          */
/* -------------------------------------------------------------------------- */

describe("compareOrderValuesDesc", () => {
  it("orders timestamps newest first", () => {
    const older = new Timestamp(1000, 0);
    const newer = new Timestamp(2000, 0);
    expect(compareOrderValuesDesc(newer, older)).toBeLessThan(0);
    expect(compareOrderValuesDesc(older, newer)).toBeGreaterThan(0);
  });
  it("orders numbers and strings descending", () => {
    expect(compareOrderValuesDesc(5, 1)).toBeLessThan(0);
    expect(compareOrderValuesDesc("a", "b")).toBeGreaterThan(0);
  });
});

describe("compareKeysetDesc", () => {
  it("breaks ties on equal order values by document id (descending)", () => {
    const a = { value: 1, id: "aaa" };
    const b = { value: 1, id: "bbb" };
    // equal value → larger id sorts first
    expect(compareKeysetDesc(b, a)).toBeLessThan(0);
    expect(compareKeysetDesc(a, b)).toBeGreaterThan(0);
    expect(compareKeysetDesc(a, a)).toBe(0);
  });

  it("sorts a mixed list into a stable (value desc, id desc) order", () => {
    const ts = (s: number) => new Timestamp(s, 0);
    const rows = [
      { value: ts(100), id: "a" },
      { value: ts(200), id: "b" },
      { value: ts(100), id: "c" },
      { value: ts(200), id: "a" }
    ];
    const sorted = [...rows].sort(compareKeysetDesc).map((r) => r.id);
    // 200/b, 200/a, then 100/c, 100/a
    expect(sorted).toEqual(["b", "a", "c", "a"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Integration: cursor paging against the Firestore emulator                  */
/* -------------------------------------------------------------------------- */

const COLLECTION = "topics";

async function seedTopics(userId: string, count: number, sharedTimestamp = false): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    // Descending newest-first means higher `i` (later createdAt) comes first.
    const createdAt = sharedTimestamp ? new Timestamp(1_700_000_000, 0) : new Timestamp(1_700_000_000 + i, 0);
    const ref = await db.collection(COLLECTION).add({ userId, name: `t-${i}`, createdAt });
    ids.push(ref.id);
  }
  return ids;
}

async function drainAllPages(userId: string, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  // Guard against an accidental infinite loop in the test itself.
  for (let guard = 0; guard < 1000; guard++) {
    const page = await listScopedPage({ collection: COLLECTION, userId, cursor, pageSize });
    seen.push(...page.items.map((d) => d.id));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("drainAllPages did not terminate");
}

describe.skipIf(!EMULATOR_AVAILABLE)("integration: listScopedPage keyset pagination", () => {
  it("returns the first page newest-first with a nextCursor when more remain", async () => {
    const userId = uid();
    await seedTopics(userId, 5);
    const page = await listScopedPage({ collection: COLLECTION, userId, pageSize: 3 });
    expect(page.items.length).toBe(3);
    expect(page.nextCursor).toBeTypeOf("string");
    expect(page.items.map((d) => d.name)).toEqual(["t-4", "t-3", "t-2"]);
  });

  it("advances via the cursor and reports exhaustion with a null nextCursor", async () => {
    const userId = uid();
    await seedTopics(userId, 5);
    const first = await listScopedPage({ collection: COLLECTION, userId, pageSize: 3 });
    const second = await listScopedPage({ collection: COLLECTION, userId, pageSize: 3, cursor: first.nextCursor });
    expect(second.items.map((d) => d.name)).toEqual(["t-1", "t-0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("walks a large dataset with no duplicates or gaps", async () => {
    const userId = uid();
    const ids = await seedTopics(userId, 47);
    const seen = await drainAllPages(userId, 7);
    expect(seen.length).toBe(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("stays stable (no dupes/gaps) when every doc shares the same orderField value", async () => {
    const userId = uid();
    const ids = await seedTopics(userId, 30, /* sharedTimestamp */ true);
    const seen = await drainAllPages(userId, 4);
    expect(seen.length).toBe(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("rejects a malformed cursor with bad_request (400)", async () => {
    const userId = uid();
    await seedTopics(userId, 1);
    await expect(
      listScopedPage({ collection: COLLECTION, userId, cursor: "!!!definitely-not-valid!!!" })
    ).rejects.toMatchObject({ code: "bad_request", status: 400 });
  });
});

describe.skipIf(!EMULATOR_AVAILABLE)("integration: GET /topics pagination contract", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("returns the additive { topics, items, nextCursor } shape and pages via cursor", async () => {
    const user = await seedUser();
    await seedTopics(user.userId, 5);

    const p1 = await srv.request("GET", "/topics?limit=3", { token: user.token });
    expect(p1.status).toBe(200);
    expect(Array.isArray(p1.body.topics)).toBe(true);
    expect(p1.body.topics).toEqual(p1.body.items); // legacy key mirrors items
    expect(p1.body.items.length).toBe(3);
    expect(typeof p1.body.nextCursor).toBe("string");

    const p2 = await srv.request(
      "GET",
      `/topics?limit=3&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
      { token: user.token }
    );
    expect(p2.body.items.length).toBe(2);
    expect(p2.body.nextCursor).toBeNull();

    const all = [...p1.body.items, ...p2.body.items].map((d: { id: string }) => d.id);
    expect(new Set(all).size).toBe(5);
  });

  it("rejects a malformed cursor with HTTP 400", async () => {
    const user = await seedUser();
    const res = await srv.request("GET", "/topics?cursor=%21%21%21bad", { token: user.token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });
});
