import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { bumpCounter } from "../stats";
import { sendError } from "../errors";
import { TopicSchema } from "../schemas";

export const topicsRouter = Router();

topicsRouter.get("/topics", async (req: AuthedRequest, res: Response) => {
  try {
    const topics = await listScoped({ collection: "topics", userId: req.userId! });
    res.json({ topics });
  } catch (err) {
    sendError(req, res, err);
  }
});

topicsRouter.post("/topics", async (req: AuthedRequest, res: Response) => {
  try {
    const body = TopicSchema.parse(req.body);
    const ref = await db.collection("topics").add({
      userId: req.userId,
      name: body.name,
      description: body.description || null,
      createdAt: serverTime()
    });
    await bumpCounter(req.userId!, "topics");
    await logEvent(req.userId!, "topic_created", body.name, { id: ref.id });
    res.json({ id: ref.id, status: "created" });
  } catch (err) {
    sendError(req, res, err);
  }
});
