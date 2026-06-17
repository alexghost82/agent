import { Router, Response } from "express";
import { db } from "../firebase";
import { serverTime, logEvent } from "../util";
import { tsMillis } from "../pure";
import { AuthedRequest } from "../auth";
import { TopicSchema } from "../schemas";

export const topicsRouter = Router();

topicsRouter.get("/topics", async (req: AuthedRequest, res: Response) => {
  try {
    const snap = await db.collection("topics").where("userId", "==", req.userId).limit(200).get();
    const topics = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    res.json({ topics });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "topics_failed" });
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
    await logEvent(req.userId!, "topic_created", body.name, { id: ref.id });
    res.json({ id: ref.id, status: "created" });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "topic_create_failed" });
  }
});
