import { Router, Response } from "express";
import { db } from "../firebase";
import { tsMillis } from "../pure";
import { AuthedRequest } from "../auth";

export const dashboardRouter = Router();

const COUNT_COLLECTIONS = [
  "topics",
  "sources",
  "knowledge_chunks",
  "agent_skills",
  "projects",
  "project_decisions",
  "generated_plans",
  "agent_logs"
];

dashboardRouter.get("/dashboard", async (req: AuthedRequest, res: Response) => {
  try {
    const counts: Record<string, number> = {};
    await Promise.all(
      COUNT_COLLECTIONS.map(async (name) => {
        const snap = await db.collection(name).where("userId", "==", req.userId).count().get();
        counts[name] = snap.data().count;
      })
    );
    const logsSnap = await db.collection("agent_logs").where("userId", "==", req.userId).limit(50).get();
    const recentLogs = logsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => tsMillis(b.createdAt) - tsMillis(a.createdAt))
      .slice(0, 10);
    res.json({ counts, recentLogs });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "dashboard_failed" });
  }
});
