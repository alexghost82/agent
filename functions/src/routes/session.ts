import { Router, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { serverTime } from "../util";
import { AuthedRequest } from "../auth";
import { sendError } from "../errors";
import { log } from "../log";

export const sessionRouter = Router();

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
    log("info", "logout", { requestId: req.requestId, userId: req.userId });
    res.json({ ok: true });
  } catch (err) {
    sendError(req, res, err);
  }
});
