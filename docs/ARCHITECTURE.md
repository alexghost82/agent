# GHOST Agent Builder Architecture

## Core loop

```text
Topic -> Sources (links) -> Knowledge Memory -> Skills -> Project (read-only GitHub) -> Design -> Plan (md files + prompts)
```

## Multi-tenancy

Every document carries a `userId`. All reads filter by `userId`, so users are
fully isolated. Authentication is a Bearer session token validated on every
request (see `src/auth.ts`). Direct client access to Firestore is denied; all
access goes through authenticated Cloud Functions (Admin SDK).

## Firestore collections

- `users` — credentials (scrypt hash), `sessionToken`, optional `githubToken`.
- `topics` — user-defined themes that group sources and produce skills.
- `sources` — studied links (websites / GitHub), with denormalized `chunkCount`.
- `knowledge_chunks` — memory chunks with embeddings; `scope` is `topic` or `project`.
- `agent_skills` — reusable skills generated from a topic's knowledge.
- `projects` — user projects, with `repoUrl`, `skillIds`, GitHub `summary`, `ingestStatus`.
- `project_decisions` — design decisions per project/section.
- `generated_plans` — generated md files and agent prompts.
- `agent_logs` — per-user audit trail.

## Backend modules (`functions/src`)

- `firebase.ts`, `util.ts`, `ai.ts`, `memory.ts`, `pure.ts` — infrastructure and helpers.
- `auth.ts` — password hashing (scrypt), seed users, `requireAuth` middleware.
- `ratelimit.ts` — best-effort per-user rate limiting.
- `ssrf.ts` — SSRF-guarded URL fetching (blocks private/loopback/link-local hosts).
- `github.ts` — read-only repository ingestion (GET requests only).
- `routes/*` — one router per area (topics, sources, skills, projects, ask, design, plans, dashboard).

## Safety model

- The agent reads GitHub repositories but never modifies them.
- Generated md files and prompts are downloadable artifacts; nothing is applied automatically.
- Secrets stay on the server (OpenAI key, GitHub token); CORS can be restricted via `ALLOWED_ORIGINS`.
