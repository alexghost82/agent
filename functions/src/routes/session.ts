import { Router, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { serverTime } from "../util";
import { AuthedRequest, makeSalt, hashPassword, verifyPassword, clearSessionCookie } from "../auth";
import { rateLimit } from "../ratelimit";
import { sendError, unauthorized, badRequest } from "../errors";
import { ChangePasswordSchema } from "../schemas";
import { log } from "../log";

export const sessionRouter = Router();

// Change the authenticated user's password (SECURITY / CONTRACT v3). Verifies
// the current password, then rotates the salt + hash. Invalidates the existing
// session so a stolen bearer cannot outlive a password change.
sessionRouter.post(
  "/change-password",
  rateLimit("change-password", 10, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
      const ref = db.collection("users").doc(req.userId!);
      const data = (await ref.get()).data();
      if (!data || !data.salt || !data.passwordHash) {
        throw badRequest("password_not_set");
      }
      if (!verifyPassword(currentPassword, data.salt, data.passwordHash)) {
        throw unauthorized();
      }
      const salt = makeSalt();
      await ref.update({
        salt,
        passwordHash: hashPassword(newPassword, salt),
        // Force re-login: invalidate the current session on password change.
        sessionTokenHash: FieldValue.delete(),
        sessionExpiresAt: FieldValue.delete(),
        sessionUpdatedAt: serverTime()
      });
      clearSessionCookie(res);
      log("info", "password_changed", { requestId: req.requestId, userId: req.userId });
      res.json({ status: "password_changed" });
    } catch (err) {
      sendError(req, res, err);
    }
  }
);

// Server-side logout (contract §1): invalidates the session in Firestore so a
// previously issued bearer token can no longer authenticate. Mounted after
// requireAuth, so it always runs for the authenticated owner only.
sessionRouter.post("/logout", async (req: AuthedRequest, res: Response) => {
  try {
    await db.collection("users").doc(req.userId!).update({
      sessionTokenHash: FieldValue.delete(),
      sessionExpiresAt: FieldValue.delete(),
      sessionUpdatedAt: serverTime()
    });
    clearSessionCookie(res);
    log("info", "logout", { requestId: req.requestId, userId: req.userId });
    res.json({ ok: true });
  } catch (err) {
    sendError(req, res, err);
  }
});
