# ROADMAP.md — Improvement Roadmap

Priority: P0 (now) · P1 (next) · P2 (later). Effort in ideal engineer-hours.

## Quick Wins (P0, < 1 day each)
1. **Encrypt `githubToken`** with existing `crypto.ts`. ~2h. `projects.ts:79,99`.
2. **Rate-limit `/login`** (per username + IP). ~2h. `public.ts:14`, `ratelimit.ts`.
3. **Add `.max()` bounds** to all zod schemas. ~3h. `schemas.ts`.
4. **Seed users once** (remove per-login `ensureSeedUsers`). ~2h. `public.ts:17`.
5. **Pin root dependencies** to explicit versions. ~1h. `package.json`.
6. **Require explicit CORS allow-list** in prod. ~1h. `index.ts:42-47`.
7. **Generic client error messages** + server log. ~3h.
8. **LRU cap** on provider client caches. ~1h. `providers/*`.

## Session & auth hardening (P0–P1)
9. **Session `expiresAt` + check** in `requireAuth`; rotate on login. ~4h.
10. **Server-side logout** endpoint clearing `sessionToken`. ~2h.
11. **Hash stored session tokens** (store hash, compare hash). ~3h.
12. **Log decrypt failures**; decide fail-closed for user calls. ~2h. `ai.ts:33-39`.

## Scalability (P1)
13. **Replace in-memory cosine with a vector index** (Firestore Vector Search or external). ~3–5d. `memory.ts`.
14. **Async GitHub ingestion** via Cloud Tasks/Pub-Sub with progress + retries. ~3–4d. `github.ts`, `projects.ts`.
15. **Parallelize file fetches** (bounded concurrency) in ingestion. ~1d.
16. **Batch embedding API calls**. ~1d. `sources.ts`, `github.ts`.
17. **Maintain counter docs** for dashboard instead of `count()` per load. ~1d.
18. **Add Firestore indexes + `orderBy().limit()`**, drop in-memory sorts. ~1d.
19. **TTL policy on `agent_logs`**. ~2h.
20. **Distributed rate limiting** (Firestore/Redis) for AI endpoints. ~1–2d.

## Testing & reliability (P1)
21. **Integration tests** against the Firestore emulator for each router. ~3d.
22. **Auth/isolation tests** (user A cannot access user B). ~1d. (`test/keys.test.ts:273-275` todos).
23. **Route tests for `/ask`, `/design`, `/plan`, `/learn`** incl. error paths. ~2d.
24. **Enable the `it.todo` over-sized-key test** after S6 fix. ~1h.
25. **CI: run frontend lint + add coverage gate**. ~3h. `.github/workflows/ci.yml`.

## Observability / DevOps (P1–P2)
26. **Structured logging** with request/correlation ids. ~1d.
27. **Error tracking** (Sentry/Cloud Error Reporting). ~0.5d.
28. **Health/readiness incl. AI + Firestore probes**. ~0.5d. (`public.ts:10`).
29. **Function min-instances / concurrency tuning** to cut cold starts. ~0.5d.
30. **Backups / export schedule** for Firestore. ~0.5d.

## Product / UX (P1–P2)
31. **Stream LLM responses** (ask/design/plan) for perceived speed. ~2d.
32. **Markdown rendering** of answers/plans (currently `<pre>`/plain text). ~1d. `app/page.tsx:482-491,1004`.
33. **Source/skill/project delete + edit** (only create/patch exist today). ~2d.
34. **Re-learn / refresh source** & dedupe of chunks. ~1d.
35. **Plan export as a zip** of all md files. ~0.5d.
36. **Project ingest progress UI** (depends on #14). ~1d.
37. **Pagination** for sources/skills/projects/logs. ~1d.
38. **Empty-state onboarding** wizard for first-time users. ~1d.
39. **Bulk skill selection** + skill search in project view. ~0.5d.
40. **Copy-all prompts** button. ~0.5d.

## Monetization / growth (P2)
41. **Usage metering per user** (tokens, ingests) → billing tiers. ~3d.
42. **Team/workspace sharing** of topics/skills. ~1w.
43. **Template library** of starter topics/skills. ~2d.
44. **More providers** (Anthropic, Azure OpenAI) via existing contract. ~2d each.
45. **Public read-only share links** for generated plans. ~2d.

## Code quality (P2)
46. **Extract shared "list+sort+scope" helper** across routers. ~0.5d.
47. **Split `app/page.tsx`** into per-step components + a data hook. ~2d.
48. **Remove `any`** in `ai.ts`/route catch blocks; typed errors. ~1d.
49. **Shared typed Firestore converters** for collections. ~1d.
50. **Document env + runbook** in README (deploy, emulators, secrets). ~0.5d.

---

### Suggested sequencing
- **Sprint 1 (P0):** 1–8, 9–11 — security & auth hardening + quick wins.
- **Sprint 2 (P1):** 13, 14, 16, 18, 21–23 — scale + test foundation.
- **Sprint 3 (P1/P2):** observability (26–30), UX (31–34), then product/monetization.
