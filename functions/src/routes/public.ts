import { Router } from "express";
import * as crypto from "crypto";
import { db } from "../firebase";
import { serverTime } from "../util";
import { ensureSeedUsers, verifyPassword } from "../auth";
import { LoginSchema } from "../schemas";

export const publicRouter = Router();

publicRouter.get("/health", (_req, res) => {
  res.json({ ok: true, version: "ghost-2.0" });
});

publicRouter.post("/login", async (req, res) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);
    await ensureSeedUsers();
    const ref = db.collection("users").doc(username.trim().toLowerCase());
    const doc = await ref.get();
    const data = doc.data();
    if (!doc.exists || !data || !verifyPassword(password, data.salt, data.passwordHash)) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    await ref.update({ sessionToken: token, lastLoginAt: serverTime() });
    res.json({ ok: true, token, user: { username: data.username } });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "login_failed" });
  }
});
