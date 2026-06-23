/**
 * Integration tests — maintenance router (POST /me/wipe) + the shared
 * `wipeUserData` core, against the Firestore emulator.
 *
 * Self-skips when the emulator is unavailable (EMULATOR_AVAILABLE), following
 * the pattern used by every suite under functions/test/integration/**. The
 * production harness's buildApp() is intentionally NOT edited (file ownership),
 * so we mount the maintenance router on a minimal Express app here — wired with
 * the real requireAuth + error envelope — and drive it over HTTP.
 *
 * Coverage:
 *  - confirm guard: POST without { confirm: true } is rejected 400 (no deletion).
 *  - happy path: POST { confirm: true } returns { status: "wiped", deleted }.
 *  - owner isolation: wipeUserData(user1) clears user1 across every collection
 *    (incl. project-intelligence artifacts) and resets counters, while user2's
 *    data is fully untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Response, NextFunction } from "express";

import {
  EMULATOR_AVAILABLE,
  db,
  startServer,
  seedUser,
  addDoc,
  expectError,
  type TestServer
} from "./helpers/harness";
import { requestId } from "../src/log";
import { requireAuth, type AuthedRequest } from "../src/auth";
import { sendError, notFound } from "../src/errors";
import { maintenanceRouter, wipeUserData, WIPE_COLLECTIONS } from "../src/routes/maintenance";
import { COUNTED_COLLECTIONS } from "../src/stats";

// Minimal app: requestId -> json -> requireAuth -> maintenanceRouter, plus the
// same 404 + error-envelope tail index.ts uses. Enough to exercise the real
// handler (auth, confirm guard, response shape) over HTTP.
function buildMaintenanceApp(): express.Express {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use(requireAuth);
  app.use(maintenanceRouter);
  app.use((req: AuthedRequest, res: Response) => sendError(req, res, notFound()));
  app.use((err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => sendError(req, res, err));
  return app;
}

async function countOwned(collection: string, userId: string): Promise<number> {
  const snap = await db.collection(collection).where("userId", "==", userId).get();
  return snap.size;
}

describe.skipIf(!EMULATOR_AVAILABLE)("integration: maintenance wipe", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer(buildMaintenanceApp());
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access (401)", async () => {
    expectError(await srv.request("POST", "/me/wipe", { body: { confirm: true } }), 401, "unauthorized");
  });

  it("rejects the wipe without an explicit confirm (400) and deletes nothing", async () => {
    const user = await seedUser();
    await addDoc("topics", { userId: user.userId, title: "keep me" });

    // Missing body.
    expectError(await srv.request("POST", "/me/wipe", { token: user.token }), 400, "bad_request");
    // Explicit confirm:false is still a no-go.
    expectError(
      await srv.request("POST", "/me/wipe", { token: user.token, body: { confirm: false } }),
      400,
      "bad_request"
    );

    // The guard short-circuits before any deletion.
    expect(await countOwned("topics", user.userId)).toBe(1);
  });

  it("wipes the caller's data over HTTP with confirm:true", async () => {
    const user = await seedUser();
    await addDoc("topics", { userId: user.userId, title: "t" });
    await addDoc("sources", { userId: user.userId, url: "https://example.com" });

    const res = await srv.request("POST", "/me/wipe", { token: user.token, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("wiped");
    expect(res.body.deleted.topics).toBe(1);
    expect(res.body.deleted.sources).toBe(1);

    expect(await countOwned("topics", user.userId)).toBe(0);
    expect(await countOwned("sources", user.userId)).toBe(0);
  });

  it("wipes user1 across every collection while leaving user2 intact (owner isolation)", async () => {
    const user1 = await seedUser();
    const user2 = await seedUser();

    // One owned doc per wipe collection for BOTH users.
    for (const c of WIPE_COLLECTIONS) {
      await addDoc(c, { userId: user1.userId });
      await addDoc(c, { userId: user2.userId });
    }

    // A project + its intelligence artifacts for both users (purged via projects).
    const proj1 = await addDoc("projects", { userId: user1.userId, name: "p1", description: "scoped" });
    const proj2 = await addDoc("projects", { userId: user2.userId, name: "p2", description: "scoped" });
    await addDoc("project_nodes", { userId: user1.userId, projectId: proj1, nodeId: "n1" });
    await addDoc("project_maps", { userId: user1.userId, projectId: proj1 });
    await addDoc("project_nodes", { userId: user2.userId, projectId: proj2, nodeId: "n2" });

    // Pre-existing counters that must end at 0.
    await db
      .collection("user_stats")
      .doc(user1.userId)
      .set({ topics: 7, projects: 3, agent_logs: 9, knowledge_chunks: 4 }, { merge: true });

    const { deleted } = await wipeUserData(user1.userId);

    // user1: every wipe collection emptied; the generic loop seeded 1 each, and
    // `projects` additionally has the explicit proj1 -> 2 total.
    for (const c of WIPE_COLLECTIONS) {
      expect(await countOwned(c, user1.userId)).toBe(0);
    }
    expect(deleted.projects).toBe(2);

    // user1: project-intelligence artifacts purged; deleted summary reflects them.
    expect(await countOwned("project_nodes", user1.userId)).toBe(0);
    expect(await countOwned("project_maps", user1.userId)).toBe(0);
    expect(deleted.project_intel).toBe(2);

    // user2: completely untouched (data + intel).
    for (const c of WIPE_COLLECTIONS) {
      expect(await countOwned(c, user2.userId)).toBeGreaterThanOrEqual(1);
    }
    expect(await countOwned("project_nodes", user2.userId)).toBe(1);

    // user1: all maintained counters reset to 0.
    const stats = (await db.collection("user_stats").doc(user1.userId).get()).data() || {};
    for (const c of COUNTED_COLLECTIONS) {
      expect(stats[c]).toBe(0);
    }
  });
});
