import { z } from "zod";

// Upper bounds on every free-text field guard against storage bloat, oversized
// LLM token spend and abuse/DoS. Bounds are generous but finite.
const NAME_MAX = 200;
const DESC_MAX = 5000;
const URL_MAX = 2048;
const ID_MAX = 256;
const INSTRUCTIONS_MAX = 8000;
const QUESTION_MAX = 8000;
// The design "section" field now also carries a free-form platform idea (incl.
// greenfield/from-scratch projects), so it needs generous room for a detailed
// idea/brief — well above a short module name, while still bounded (DoS/cost).
const IDEA_MAX = 20000;
const EXAMPLE_MAX = 8000;
const KEY_MAX = 500;
const TOKEN_MAX = 500;
const TAG_MAX = 64;
const TAGS_MAX = 50;

const tags = z.array(z.string().min(1).max(TAG_MAX)).max(TAGS_MAX);

// Optional reply-language hint for agent outputs. Backward compatible: when
// omitted the backend keeps its previous default (Russian).
const replyLang = z.enum(["en", "he", "ru"]).optional();

export const LoginSchema = z.object({
  username: z.string().min(1).max(NAME_MAX),
  password: z.string().min(1).max(512)
});

export const TopicSchema = z.object({
  name: z.string().min(2).max(NAME_MAX),
  description: z.string().max(DESC_MAX).optional()
});

export const LearnSchema = z.object({
  topicId: z.string().min(3).max(ID_MAX),
  url: z.string().url().max(URL_MAX),
  tags: tags.optional()
});

export const ExtractSkillsSchema = z.object({ topicId: z.string().min(3).max(ID_MAX) });

export const SkillSchema = z.object({
  topicId: z.string().min(3).max(ID_MAX),
  skillName: z.string().min(2).max(NAME_MAX),
  description: z.string().min(5).max(DESC_MAX),
  example: z.string().max(EXAMPLE_MAX).optional()
});

export const AskSchema = z.object({
  question: z.string().min(3).max(QUESTION_MAX),
  limit: z.number().int().min(1).max(50).optional(),
  lang: replyLang
});

export const ProjectSchema = z.object({
  name: z.string().min(2).max(NAME_MAX),
  description: z.string().min(5).max(DESC_MAX),
  stack: z.string().max(NAME_MAX).optional(),
  repoUrl: z.string().max(URL_MAX).optional()
});

export const UpdateProjectSchema = z.object({
  skillIds: z.array(z.string().min(1).max(ID_MAX)).max(200).optional(),
  name: z.string().min(2).max(NAME_MAX).optional(),
  description: z.string().min(5).max(DESC_MAX).optional(),
  stack: z.string().max(NAME_MAX).optional(),
  repoUrl: z.string().max(URL_MAX).optional()
});

export const ConnectGithubSchema = z.object({ repoUrl: z.string().min(3).max(URL_MAX) });

export const GithubTokenSchema = z.object({ token: z.string().min(1).max(TOKEN_MAX) });

export const DesignSchema = z.object({
  projectId: z.string().min(3).max(ID_MAX),
  // Free-form platform idea / direction / section / module (all optional).
  // Kept as `section` for backward compatibility with the existing API.
  section: z.string().max(IDEA_MAX).optional(),
  lang: replyLang
});

export const GeneratePlanSchema = z.object({
  projectId: z.string().min(3).max(ID_MAX),
  instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
  lang: replyLang
});

// Per-user provider API keys. A string sets/replaces the key, `null` deletes it,
// and omitting a field leaves it untouched. Keys are validated by provider prefix
// and bounded in length (DoS / cost-abuse guard).
export const ApiKeysSchema = z.object({
  openai: z.string().regex(/^sk-/, "OpenAI key must start with sk-").max(KEY_MAX).nullable().optional(),
  gemini: z.string().regex(/^AIza/, "Gemini key must start with AIza").max(KEY_MAX).nullable().optional(),
  provider: z.enum(["openai", "gemini"]).optional()
});

export const TestKeySchema = z.object({ provider: z.enum(["openai", "gemini"]) });
