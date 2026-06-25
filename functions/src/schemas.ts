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

// iOS/mobile: exchange a verified Firebase Auth ID token for a GHOST session.
export const FirebaseAuthSchema = z.object({
  idToken: z.string().min(10).max(8192)
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(8).max(512)
});

// User management v2 (SECURITY): admin-issued invites, invite redemption, roles.
export const CreateInviteSchema = z.object({
  role: z.enum(["admin", "member"]).optional(),
  // Optional expiry in hours (default applied server-side).
  expiresInHours: z.number().int().min(1).max(8760).optional()
});

export const AcceptInviteSchema = z.object({
  code: z.string().min(8).max(128),
  username: z.string().min(2).max(NAME_MAX),
  password: z.string().min(8).max(512)
});

export const UpdateRoleSchema = z.object({
  role: z.enum(["admin", "member"])
});

export const TopicSchema = z.object({
  name: z.string().min(2).max(NAME_MAX),
  description: z.string().max(DESC_MAX).optional()
});

export const LearnSchema = z.object({
  topicId: z.string().min(3).max(ID_MAX),
  url: z.string().url().max(URL_MAX),
  tags: tags.optional(),
  // Deep ingest (CONTRACT v3.5): bounded same-origin crawl. Default false keeps
  // the single-page behaviour (fully backward compatible).
  deep: z.boolean().optional()
});

export const ExtractSkillsSchema = z.object({ topicId: z.string().min(3).max(ID_MAX) });

export const SkillSchema = z.object({
  topicId: z.string().min(3).max(ID_MAX),
  skillName: z.string().min(2).max(NAME_MAX),
  description: z.string().min(5).max(DESC_MAX),
  example: z.string().max(EXAMPLE_MAX).optional(),
  // Skill v2 (CONTRACT v3.3): which stacks/tags the skill applies to and an
  // optional reusable template the build step can apply. Backward compatible.
  appliesTo: tags.optional(),
  template: z.string().max(EXAMPLE_MAX).optional()
});

// Partial update of an owned skill (PATCH /skills/:id). Every field is optional
// (so callers can patch just the name/description) but at least one must be
// present. `example`/`template` accept null to clear them. Mirrors the bounds of
// SkillSchema so an edited skill stays within the same storage/cost limits.
export const SkillUpdateSchema = z
  .object({
    skillName: z.string().min(2).max(NAME_MAX).optional(),
    description: z.string().min(5).max(DESC_MAX).optional(),
    example: z.string().max(EXAMPLE_MAX).nullable().optional(),
    appliesTo: tags.optional(),
    template: z.string().max(EXAMPLE_MAX).nullable().optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });

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
  // Optional skill categories (topic ids): when present, the design step also
  // pulls in skills belonging to these topics. Backward compatible when absent.
  topicIds: z.array(z.string().min(3).max(ID_MAX)).max(50).optional(),
  lang: replyLang
});

// Persisted n8n-style flow map for a project (one doc per project+kind). Nodes
// and edges are loose objects from the client editor; bounded to guard DoS/cost.
const MAP_ITEMS_MAX = 500;
export const FlowMapSchema = z.object({
  kind: z.enum(["design", "project"]),
  nodes: z.array(z.record(z.string(), z.unknown())).max(MAP_ITEMS_MAX),
  edges: z.array(z.record(z.string(), z.unknown())).max(MAP_ITEMS_MAX)
});

// Project-intelligence scan request. Body is optional; both fields default
// server-side. `depth` bounds the graph; `ai` enables the (clearly-marked)
// AI summary layer.
export const ScanRequestSchema = z.object({
  depth: z.number().int().min(1).max(30).optional(),
  ai: z.boolean().optional()
});

export const GeneratePlanSchema = z.object({
  projectId: z.string().min(3).max(ID_MAX),
  instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
  lang: replyLang
});

// Real-development BUILD request (CONTRACT v2.2). `projectId` comes from the
// route param; `planId` (optional) seeds the build from an owned generated plan.
export const BuildSchema = z.object({
  planId: z.string().min(3).max(ID_MAX).optional(),
  instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
  lang: replyLang
});

// Autonomous agent run (Autopilot): one call drives links + a task through the
// whole cycle (learn → skills → design → plan → verified build). `urls` is
// bounded (>=1, capped) and `task` reuses the generous idea bound. The heavy
// orchestration runs as an async AI job; the route only validates + enqueues.
const AGENT_URLS_MAX = 20;
export const AgentRunSchema = z.object({
  urls: z.array(z.string().url().max(URL_MAX)).min(1).max(AGENT_URLS_MAX),
  task: z.string().min(3).max(IDEA_MAX),
  // Bounded same-origin crawl per URL (same semantics as /learn `deep`).
  deep: z.boolean().optional(),
  lang: replyLang
});

// Per-user provider API keys. A string sets/replaces the key, `null` deletes it,
// and omitting a field leaves it untouched. Keys are validated by provider prefix
// and bounded in length (DoS / cost-abuse guard).
export const ApiKeysSchema = z.object({
  openai: z.string().regex(/^sk-/, "OpenAI key must start with sk-").max(KEY_MAX).nullable().optional(),
  gemini: z.string().regex(/^AIza/, "Gemini key must start with AIza").max(KEY_MAX).nullable().optional(),
  anthropic: z.string().regex(/^sk-ant-/, "Anthropic key must start with sk-ant-").max(KEY_MAX).nullable().optional(),
  azure: z.string().min(8).max(KEY_MAX).nullable().optional(),
  provider: z.enum(["openai", "gemini", "anthropic", "azure-openai"]).optional()
});

export const TestKeySchema = z.object({ provider: z.enum(["openai", "gemini", "anthropic", "azure-openai"]) });
