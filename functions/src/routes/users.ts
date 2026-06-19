import { Router, Response } from "express";
import * as crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase";
import { serverTime } from "../util";
import { AuthedRequest, requireRole } from "../auth";
import { rateLimit } from "../ratelimit";
import { sendError, notFound } from "../errors";
import { CreateInviteSchema, UpdateRoleSchema } from "../schemas";
import { log } from "../log";

// Admin-only user management (SECURITY v2): invites, listing users, role changes.
// Every route is gated by requireRole("admin"); requireAuth runs upstream in
// index.ts so req.userId/req.role are populated.
export const usersRouter = Router();

const DEFAULT_INVITE_TTL_HOURS = 168; // 7 days

// Create a single-use invite code. The plaintext code is returned ONCE to the
// admin to share out-of-band; only its value (as doc id) is stored.
usersRouter.post(
  "/invites",
  requireRole("admin"),
  rateLimit("create-invite", 30, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { role, expiresInHours } = CreateInviteSchema.parse(req.body);
      const code = crypto.randomBytes(24).toString("hex");
      const ttlH = expiresInHours ?? DEFAULT_INVITE_TTL_HOURS;
      await db.collection("invites").doc(code).set({
        role: role || "member",
        used: false,
        createdBy: req.userId,
        createdAt: serverTime(),
        expireAt: Timestamp.fromMillis(Date.now() + ttlH * 60 * 60 * 1000)
      });
      log("info", "invite_created", { requestId: req.requestId, userId: req.userId, role: role || "member" });
      res.json({ code, role: role || "member", expiresInHours: ttlH });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);

// List invites (no secrets beyond the code itself, which the admin already saw).
usersRouter.get("/invites", requireRole("admin"), async (req: AuthedRequest, res: Response) => {
  try {
    const snap = await db.collection("invites").orderBy("createdAt", "desc").limit(100).get();
    const invites = snap.docs.map((d) => {
      const data = d.data();
      return {
        code: d.id,
        role: data.role,
        used: !!data.used,
        usedBy: data.usedBy || null,
        createdBy: data.createdBy || null,
        createdAt: data.createdAt || null,
        expireAt: data.expireAt || null
      };
    });
    res.json({ invites });
  } catch (err) {
    sendError(req, res, err);
  }
});

// List users (id, username, role only — never salts/hashes/sessions).
usersRouter.get("/users", requireRole("admin"), async (req: AuthedRequest, res: Response) => {
  try {
    const snap = await db.collection("users").limit(500).get();
    const users = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        username: data.username || d.id,
        role: data.role === "admin" ? "admin" : "member",
        authProvider: data.authProvider || "password",
        createdAt: data.createdAt || null,
        lastLoginAt: data.lastLoginAt || null
      };
    });
    res.json({ users });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Change a user's role. Guards against an admin demoting the last admin / self,
// which would lock everyone out of administration.
usersRouter.patch("/users/:id/role", requireRole("admin"), async (req: AuthedRequest, res: Response) => {
  try {
    const targetId = String(req.params.id);
    const { role } = UpdateRoleSchema.parse(req.body);
    const ref = db.collection("users").doc(targetId);
    const snap = await ref.get();
    if (!snap.exists) {
      sendError(req, res, notFound());
      return;
    }
    if (role === "member" && snap.data()?.role === "admin") {
      const admins = await db.collection("users").where("role", "==", "admin").limit(2).get();
      if (admins.size <= 1) {
        res.status(409).json({ error: "bad_request", requestId: req.requestId });
        return;
      }
    }
    await ref.update({ role, roleUpdatedAt: serverTime(), roleUpdatedBy: req.userId });
    log("info", "role_updated", { requestId: req.requestId, by: req.userId, target: targetId, role });
    res.json({ id: targetId, role, status: "updated" });
  } catch (err) {
    sendError(req, res, err);
  }
});
