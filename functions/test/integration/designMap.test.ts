/**
 * Integration tests — design-map router against the Firestore emulator.
 *
 * Covers the full editable-map surface that ships in production but was added
 * without coverage (routes/designMap.ts + designMap/{store,validators,initialMap}):
 *   GET    /projects/:id/design-map            (seed-on-first-open)
 *   POST   /projects/:id/design-map            (full save)
 *   PATCH  /projects/:id/design-map            (partial update)
 *   POST   /projects/:id/design-map/add-skill
 *   POST   /projects/:id/design-map/add-podskill
 *
 * Every path is exercised for auth, ownership (404, no cross-tenant leak),
 * validation (400) and the happy-path persistence/version semantics — all
 * deterministic, no network or AI key required.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import {
  EMULATOR_AVAILABLE,
  startServer,
  seedUser,
  addDoc,
  expectError,
  db,
  type TestServer
} from "../helpers/harness";

// A minimal valid node/edge per the zod schema (validators.ts).
function node(id: string, type: string, label: string, x = 0, y = 0) {
  return { id, type, label, position: { x, y } };
}
function edge(id: string, source: string, target: string, type: string) {
  return { id, source, target, type };
}

describe.skipIf(!EMULATOR_AVAILABLE)("integration: design-map router", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it("rejects unauthenticated access on every verb (401)", async () => {
    expectError(await srv.request("GET", "/projects/p1/design-map"), 401, "unauthorized");
    expectError(await srv.request("POST", "/projects/p1/design-map", { body: {} }), 401, "unauthorized");
    expectError(await srv.request("PATCH", "/projects/p1/design-map", { body: {} }), 401, "unauthorized");
    expectError(
      await srv.request("POST", "/projects/p1/design-map/add-skill", { body: {} }),
      401,
      "unauthorized"
    );
    expectError(
      await srv.request("POST", "/projects/p1/design-map/add-podskill", { body: {} }),
      401,
      "unauthorized"
    );
  });

  it("GET seeds an initial map from the project on first open", async () => {
    const user = await seedUser();
    const skillId = await addDoc("agent_skills", {
      userId: user.userId,
      skillName: "Auth",
      description: "How authentication works"
    });
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Demo",
      description: "A demo project",
      stack: "Next.js + Firebase",
      summary: "Short summary",
      repoUrl: "https://github.com/acme/demo",
      skillIds: [skillId]
    });

    const res = await srv.request("GET", `/projects/${projectId}/design-map`, { token: user.token });
    expect(res.status).toBe(200);
    const map = res.body.map;
    expect(map.projectId).toBe(projectId);
    expect(map.userId).toBe(user.userId);
    // Initial seed bumps version from 0 to 1.
    expect(map.version).toBe(1);

    const ids: string[] = map.nodes.map((n: any) => n.id);
    expect(ids).toContain("project");
    expect(ids).toContain("design_section");
    expect(ids).toContain("feature-desc");
    expect(ids).toContain("feature-summary");
    expect(ids).toContain("feature-stack");
    expect(ids).toContain("feature-repo");
    expect(ids).toContain(`skill-${skillId}`);
    // Seeded skill node carries the real skill name + description (not "Skill <id>").
    const skillNode = map.nodes.find((n: any) => n.id === `skill-${skillId}`);
    expect(skillNode.label).toBe("Auth");
    expect(skillNode.description).toBe("How authentication works");
    expect(skillNode.skillId).toBe(skillId);
    // The root project node carries the project id in its data bag.
    const root = map.nodes.find((n: any) => n.id === "project");
    expect(root.data.projectId).toBe(projectId);

    // Second open returns the SAME persisted map (no re-seed / version churn).
    const again = await srv.request("GET", `/projects/${projectId}/design-map`, { token: user.token });
    expect(again.body.map.version).toBe(1);
  });

  it("seeds only owned skills and skips unknown/unowned ids", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const ownedSkill = await addDoc("agent_skills", {
      userId: user.userId,
      skillName: "Owned",
      description: "Mine"
    });
    const foreignSkill = await addDoc("agent_skills", { userId: other.userId, skillName: "Theirs" });
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Skill filter",
      skillIds: [ownedSkill, foreignSkill, "does-not-exist"]
    });

    const res = await srv.request("GET", `/projects/${projectId}/design-map`, { token: user.token });
    expect(res.status).toBe(200);
    const ids: string[] = res.body.map.nodes.map((n: any) => n.id);
    // The owned skill is rendered with its real name...
    expect(ids).toContain(`skill-${ownedSkill}`);
    const ownedNode = res.body.map.nodes.find((n: any) => n.id === `skill-${ownedSkill}`);
    expect(ownedNode.label).toBe("Owned");
    expect(ownedNode.description).toBe("Mine");
    // ...while the foreign and non-existent ids are skipped entirely.
    expect(ids).not.toContain(`skill-${foreignSkill}`);
    expect(ids).not.toContain("skill-does-not-exist");
  });

  it("GET derives the map from the latest completed scan graph", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "Scanned",
      description: "Has a scan",
      skillIds: []
    });

    // A completed scan plus its persisted graph snapshot (project_maps) and a
    // per-node detail doc (project_nodes) — exactly what persistScanGraph writes.
    const scanRef = await db.collection("project_scans").add({
      userId: user.userId,
      projectId,
      status: "completed",
      createdAt: FieldValue.serverTimestamp()
    });
    const scanId = scanRef.id;
    await db.collection("project_maps").doc(scanId).set({
      userId: user.userId,
      projectId,
      scanId,
      nodes: [
        { id: "project-root", type: "project", label: "Scanned" },
        { id: "feat-auth", type: "feature", label: "Auth", confidence: "high" },
        { id: "route-login", type: "apiRoute", label: "login.ts" }
      ],
      edges: [
        { id: "e1", source: "project-root", target: "feat-auth", type: "owns" },
        { id: "e2", source: "feat-auth", target: "route-login", type: "depends_on" }
      ],
      createdAt: FieldValue.serverTimestamp()
    });
    await db.collection("project_nodes").doc(`${scanId}__feat-auth`).set({
      userId: user.userId,
      projectId,
      scanId,
      nodeId: "feat-auth",
      description: "Authentication feature",
      usage: "Used whenever a visitor signs in",
      details: { purpose: "Authentication feature", usage: "Used whenever a visitor signs in" }
    });

    const res = await srv.request("GET", `/projects/${projectId}/design-map`, { token: user.token });
    expect(res.status).toBe(200);
    const map = res.body.map;
    const byId = new Map<string, any>(map.nodes.map((n: any) => [n.id, n]));

    // Root carries the project id; intel project node folded into it (no dup).
    expect(byId.get("project").data.projectId).toBe(projectId);
    expect(byId.has("intel-project-root")).toBe(false);

    // Intel nodes translated by type, with description + usage hydrated from
    // project_nodes.
    expect(byId.get("intel-feat-auth").type).toBe("feature");
    expect(byId.get("intel-feat-auth").description).toBe("Authentication feature");
    expect(byId.get("intel-feat-auth").data?.usage).toBe("Used whenever a visitor signs in");
    expect(byId.get("intel-route-login").type).toBe("api_route");

    // owns -> contains edge reattaches to the design root.
    expect(
      map.edges.some(
        (e: any) => e.source === "project" && e.target === "intel-feat-auth" && e.type === "contains"
      )
    ).toBe(true);
    expect(
      map.edges.some(
        (e: any) =>
          e.source === "intel-feat-auth" && e.target === "intel-route-login" && e.type === "depends_on"
      )
    ).toBe(true);

    // When a graph drives the seed, the thin project-field features are NOT used.
    expect(byId.has("feature-desc")).toBe(false);
  });

  it("falls back to the thin seed when there is no completed scan", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", {
      userId: user.userId,
      name: "No scan",
      description: "Only fields"
    });

    // A scan exists but is NOT completed -> the seeder must ignore it and fall
    // back to the project-field seed.
    await db.collection("project_scans").add({
      userId: user.userId,
      projectId,
      status: "scanning",
      createdAt: FieldValue.serverTimestamp()
    });

    const res = await srv.request("GET", `/projects/${projectId}/design-map`, { token: user.token });
    expect(res.status).toBe(200);
    const ids: string[] = res.body.map.nodes.map((n: any) => n.id);
    expect(ids).toContain("feature-desc");
    expect(ids.some((id) => id.startsWith("intel-"))).toBe(false);
  });

  it("never leaks another user's project (404 on GET)", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: owner.userId, name: "Private" });

    expectError(
      await srv.request("GET", `/projects/${projectId}/design-map`, { token: other.token }),
      404,
      "not_found"
    );
    expectError(
      await srv.request("GET", `/projects/does-not-exist/design-map`, { token: owner.token }),
      404,
      "not_found"
    );
  });

  it("POST replaces the whole map and bumps the version", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Save target" });

    const nodes = [node("project", "project", "Save target"), node("a", "feature", "Feature A", 320)];
    const edges = [edge("e-project-a", "project", "a", "contains")];
    const res = await srv.request("POST", `/projects/${projectId}/design-map`, {
      token: user.token,
      body: { nodes, edges }
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("saved");
    // No prior doc -> first save is version 1.
    expect(res.body.map.version).toBe(1);
    expect(res.body.map.nodes).toHaveLength(2);

    // A second save bumps to version 2 and replaces wholesale.
    const res2 = await srv.request("POST", `/projects/${projectId}/design-map`, {
      token: user.token,
      body: { nodes: [node("project", "project", "Only root")], edges: [] }
    });
    expect(res2.body.map.version).toBe(2);
    expect(res2.body.map.nodes).toHaveLength(1);
  });

  it("POST rejects an invalid payload (validation, 400) and a foreign project (404)", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Validate" });

    // Bad node type -> zod rejects.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map`, {
        token: user.token,
        body: { nodes: [{ id: "x", type: "not-a-type", label: "X", position: { x: 0, y: 0 } }], edges: [] }
      }),
      400,
      "validation_failed"
    );

    // Foreign project -> 404 before any write.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map`, {
        token: other.token,
        body: { nodes: [], edges: [] }
      }),
      404,
      "not_found"
    );
  });

  it("PATCH updates only the provided arrays (and 404s without an existing map)", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Patch target" });

    // No map doc yet -> patch returns null -> 404.
    expectError(
      await srv.request("PATCH", `/projects/${projectId}/design-map`, {
        token: user.token,
        body: { nodes: [node("project", "project", "Root")] }
      }),
      404,
      "not_found"
    );

    // Seed a doc, then patch only the edges; nodes must survive untouched.
    const seeded = await srv.request("GET", `/projects/${projectId}/design-map`, { token: user.token });
    const nodeCount = seeded.body.map.nodes.length;

    const patched = await srv.request("PATCH", `/projects/${projectId}/design-map`, {
      token: user.token,
      body: { edges: [] }
    });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("saved");
    expect(patched.body.map.version).toBe(2);
    expect(patched.body.map.edges).toHaveLength(0);
    expect(patched.body.map.nodes).toHaveLength(nodeCount);

    // Invalid patch body -> 400.
    expectError(
      await srv.request("PATCH", `/projects/${projectId}/design-map`, {
        token: user.token,
        body: { nodes: [{ id: "x", type: "feature" }] }
      }),
      400,
      "validation_failed"
    );
  });

  it("add-skill validates input, ownership, and is idempotent on the node id", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Skill host" });
    const skillId = await addDoc("agent_skills", {
      userId: user.userId,
      skillName: "Caching",
      description: "How to cache"
    });

    // Missing skillId -> 400.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map/add-skill`, {
        token: user.token,
        body: {}
      }),
      400,
      "bad_request"
    );

    // Foreign project -> 404.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map/add-skill`, {
        token: other.token,
        body: { skillId }
      }),
      404,
      "not_found"
    );

    // Skill the caller does not own -> 404.
    const foreignSkill = await addDoc("agent_skills", { userId: other.userId, skillName: "Theirs" });
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map/add-skill`, {
        token: user.token,
        body: { skillId: foreignSkill }
      }),
      404,
      "not_found"
    );

    // Happy path: adds a skill node + an edge from the design anchor.
    const added = await srv.request("POST", `/projects/${projectId}/design-map/add-skill`, {
      token: user.token,
      body: { skillId }
    });
    expect(added.status).toBe(200);
    expect(added.body.status).toBe("added");
    const skillNode = added.body.map.nodes.find((n: any) => n.id === `skill-${skillId}`);
    expect(skillNode).toBeTruthy();
    expect(skillNode.label).toBe("Caching");
    expect(skillNode.confidence).toBe("manual");
    const hasEdge = added.body.map.edges.some((e: any) => e.target === `skill-${skillId}`);
    expect(hasEdge).toBe(true);

    // Idempotent: re-adding does not duplicate the node.
    const again = await srv.request("POST", `/projects/${projectId}/design-map/add-skill`, {
      token: user.token,
      body: { skillId }
    });
    const count = again.body.map.nodes.filter((n: any) => n.id === `skill-${skillId}`).length;
    expect(count).toBe(1);
  });

  it("add-podskill resolves a child of an owned skill and validates its inputs", async () => {
    const user = await seedUser();
    const projectId = await addDoc("projects", { userId: user.userId, name: "Podskill host" });
    const skillId = await addDoc("agent_skills", {
      userId: user.userId,
      skillName: "Pipeline",
      podskills: [{ id: "p1", name: "Ingest" }, { id: "p2", name: "Transform" }]
    });
    const noChildrenSkill = await addDoc("agent_skills", {
      userId: user.userId,
      skillName: "Flat"
    });

    // Missing ids -> 400.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map/add-podskill`, {
        token: user.token,
        body: { skillId }
      }),
      400,
      "bad_request"
    );

    // Skill without any podskill array -> 400.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map/add-podskill`, {
        token: user.token,
        body: { skillId: noChildrenSkill, podskillId: "p1" }
      }),
      400,
      "bad_request"
    );

    // Unknown podskill id -> 404.
    expectError(
      await srv.request("POST", `/projects/${projectId}/design-map/add-podskill`, {
        token: user.token,
        body: { skillId, podskillId: "nope" }
      }),
      404,
      "not_found"
    );

    // Happy path: matched podskill becomes a node linked to its parent skill.
    const added = await srv.request("POST", `/projects/${projectId}/design-map/add-podskill`, {
      token: user.token,
      body: { skillId, podskillId: "p1" }
    });
    expect(added.status).toBe(200);
    expect(added.body.status).toBe("added");
    const nodeId = `podskill-${skillId}-p1`;
    const podNode = added.body.map.nodes.find((n: any) => n.id === nodeId);
    expect(podNode).toBeTruthy();
    expect(podNode.label).toBe("Ingest");
    expect(podNode.type).toBe("podskill");
  });
});
