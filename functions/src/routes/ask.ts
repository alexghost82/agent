import { Router, Response } from "express";
import { logEvent } from "../util";
import { generateAnswer } from "../ai";
import { searchMemory } from "../memory";
import { rateLimit } from "../ratelimit";
import { AuthedRequest } from "../auth";
import { sendError } from "../errors";
import { AskSchema } from "../schemas";

export const askRouter = Router();

askRouter.post("/ask", rateLimit("ask", 40, 60_000), async (req: AuthedRequest, res: Response) => {
  try {
    const { question, limit, lang } = AskSchema.parse(req.body);
    const context = await searchMemory(question, { userId: req.userId! }, limit || 8);
    const answer = await generateAnswer(question, context, req.userId!, lang);
    await logEvent(req.userId!, "ask", question, { sources: context.map((x) => x.id) });
    res.json({ question, answer, sources: context });
  } catch (err) {
    sendError(req, res, err);
  }
});
