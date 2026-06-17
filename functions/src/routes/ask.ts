import { Router, Response } from "express";
import { logEvent } from "../util";
import { generateAnswer } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { AskSchema } from "../schemas";

export const askRouter = Router();

askRouter.post("/ask", rateLimit("ask", 40, 60_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { question, limit } = AskSchema.parse(req.body);
    const context = await searchMemory(question, { userId: req.userId! }, limit || 8);
    const answer = await generateAnswer(question, context);
    await logEvent(req.userId!, "ask", question, { sources: context.map((x) => x.id) });
    res.json({ question, answer, sources: context });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "ask_failed" });
  }
});
