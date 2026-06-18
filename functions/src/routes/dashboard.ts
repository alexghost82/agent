import { Router, Response } from "express";
import { AuthedRequest } from "../auth";
import { listScoped } from "../listing";
import { readCounts } from "../stats";
import { sendError } from "../errors";

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard", async (req: AuthedRequest, res: Response) => {
  try {
    // One read of the maintained per-user counter doc (lazily seeded from a
    // one-time count() if absent) instead of 8 count() aggregations per load.
    const counts = await readCounts(req.userId!);
    const recentLogs = await listScoped({ collection: "agent_logs", userId: req.userId!, limit: 10 });
    res.json({ counts, recentLogs });
  } catch (err) {
    sendError(req, res, err);
  }
});
