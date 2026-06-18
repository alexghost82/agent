import { Router, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { AuthedRequest } from "../auth";
import { AiProvider, probeProvider } from "../ai";
import { encryptSecret, last4 } from "../crypto";
import { rateLimit } from "../ratelimit";
import { sendError } from "../errors";
import { ApiKeysSchema, TestKeySchema } from "../schemas";

export const keysRouter = Router();

interface KeyStatus {
  configured: boolean;
  last4?: string;
  updatedAt?: unknown;
}

interface KeysStatus {
  provider: AiProvider;
  keys: { openai: KeyStatus; gemini: KeyStatus };
}

// Builds the client-safe status object. Raw keys are never included.
function statusFromUser(data: FirebaseFirestore.DocumentData | undefined): KeysStatus {
  const provider: AiProvider = data?.aiProvider === "gemini" ? "gemini" : "openai";
  const apiKeys = data?.apiKeys || {};
  const toStatus = (entry: { ciphertext?: string; last4?: string; updatedAt?: unknown } | undefined): KeyStatus =>
    entry?.ciphertext
      ? { configured: true, last4: entry.last4, updatedAt: entry.updatedAt }
      : { configured: false };
  return {
    provider,
    keys: { openai: toStatus(apiKeys.openai), gemini: toStatus(apiKeys.gemini) }
  };
}

function encEntry(secret: string) {
  return { ...encryptSecret(secret), last4: last4(secret), updatedAt: serverTime() };
}

keysRouter.get("/me/api-keys", async (req: AuthedRequest, res: Response) => {
  try {
    const doc = await db.collection("users").doc(req.userId!).get();
    res.json(statusFromUser(doc.data()));
  } catch (err) {
    sendError(req, res, err);
  }
});

keysRouter.put("/me/api-keys", async (req: AuthedRequest, res: Response) => {
  try {
    const body = ApiKeysSchema.parse(req.body);
    const ref = db.collection("users").doc(req.userId!);
    const update: Record<string, unknown> = {};

    if (body.provider) update.aiProvider = body.provider;

    if (body.openai === null) update["apiKeys.openai"] = FieldValue.delete();
    else if (typeof body.openai === "string") update["apiKeys.openai"] = encEntry(body.openai);

    if (body.gemini === null) update["apiKeys.gemini"] = FieldValue.delete();
    else if (typeof body.gemini === "string") update["apiKeys.gemini"] = encEntry(body.gemini);

    if (Object.keys(update).length) {
      await ref.update(update);
      await logEvent(req.userId!, "api_keys_updated", "API keys updated", {
        provider: body.provider ?? null,
        openai: body.openai === null ? "deleted" : typeof body.openai === "string" ? "set" : "unchanged",
        gemini: body.gemini === null ? "deleted" : typeof body.gemini === "string" ? "set" : "unchanged"
      });
    }

    const doc = await ref.get();
    res.json(statusFromUser(doc.data()));
  } catch (err) {
    sendError(req, res, err);
  }
});

keysRouter.post(
  "/me/api-keys/test",
  rateLimit("api-keys-test", 10, 60_000),
  async (req: AuthedRequest, res: Response) => {
    try {
      const { provider } = TestKeySchema.parse(req.body);
      const result = await probeProvider(req.userId!, provider);
      res.json(result);
    } catch (err) {
      sendError(req, res, err);
    }
  }
);
