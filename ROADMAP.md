# ROADMAP.md — Improvement Roadmap

Priority: P0 (now) · P1 (next) · P2 (later). Effort in ideal engineer-hours/days.
Evidence in `path:line`. See `docs/CONTRACT.md` for the frozen v2 seams.

## Completed (verified in code)

- Encrypt `githubToken` with `crypto.ts` (`routes/projects.ts:96`).
- Rate-limit `/login` (per username + IP) (`ratelimit.ts loginThrottle`).
- `.max()` bounds on all zod schemas (`schemas.ts`).
- Seed users once per instance (`auth.ts ensureSeedUsersOnce`).
- Pin root dependencies to explicit versions (`package.json`).
- Require explicit CORS allow-list in production (`index.ts:47-55`).
- Generic client errors + server log via coded envelope (`errors.ts`).
- LRU cap on provider client caches (`lru.ts`, `providers/*`).
- Session `expiresAt` + check, rotate on login, hashed stored token, server-side
  `/logout` (`auth.ts`, `routes/public.ts`, `routes/session.ts`).
- Log decrypt failures (no longer silent) (`ai.ts:46-54`).
- Batch embedding API calls (`ai.ts embeddingBatch`).
- Maintain counter docs for the dashboard (`stats.ts`).
- Firestore composite indexes + `orderBy().limit()` listing (`listing.ts`,
  `firestore.indexes.json`).
- TTL field on `agent_logs` (`util.ts expireAt`).
- Structured logging with request/correlation ids (`log.ts`, `errors.ts`).
- Health/readiness incl. AI + Firestore probes (`routes/public.ts`).
- Function memory / timeout / concurrency tuning (`index.ts:104-107`).
- Integration tests per router + auth/isolation coverage + CI coverage gate
  (`functions/test/integration/**`, `.github/workflows/ci.yml`).
- Split the frontend into per-panel components + a data hook
  (`app/components/**`, `app/useGhostData.ts`).
- Plan/artifact export as a zip client-side (`app/zip.ts`).

## P0 — Product completion (CONTRACT v2)

1. **BUILD mode** — service + endpoints landed (`build.ts runBuild`,
   `routes/build.ts`: `POST /projects/:id/build`, `GET /builds`,
   `GET /builds/:id`; `build_runs`/`build_artifacts`; `BUILD_MAX_FILES` /
   `BUILD_MAX_FILE_BYTES`; never writes GitHub — CONTRACT §v2.2). Remaining:
   end-to-end verification, frontend wiring, and review/download polish. ~1–2d.
2. **Self-learning loop** — persist design/plan/build outcomes back into memory
   as `knowledge_chunks` (`build`/`project` scope) with `contentHash` dedup.
   ~2–3d. (CONTRACT §v2.4)
3. **Skill schema v2** — `appliesTo`/`template`/`version`/`quality`, extracted
   from the whole topic and consumed by design/plan/build. ~2–3d. (CONTRACT
   §v2.3)
4. **Deep ingest** — domain-bounded crawl (sitemap + same-origin links), PDF
   extraction, `contentHash` dedup, within `INGEST_MAX_*` bounds. ~3–4d.
   (CONTRACT §v2.5)

## P1 — Scale & hardening

5. **Replace in-memory cosine with a vector index** (Firestore `findNearest` /
   external) behind the `VectorIndex` interface. ~3–5d. `memory.ts`. (ADR-0001)
6. **Async GitHub ingestion** via Cloud Tasks/Pub-Sub with progress + retries;
   parallelize file fetches with bounded concurrency. ~4–5d. `github.ts`,
   `routes/projects.ts`.
7. **Distributed rate limiting** for expensive AI endpoints (reuse
   `consumeDistributed`). ~1d. `ratelimit.ts`.
8. **Move the session token off `localStorage`** (httpOnly cookie or short-lived
   token + strict CSP). ~2–3d. `app/api.ts`.
9. **Require a CORS allow-list in internet-exposed non-prod** environments. ~0.5d.

## P1–P2 — Observability / DevOps

10. Error tracking (Sentry / Cloud Error Reporting). ~0.5d.
11. Backups / export schedule for Firestore. ~0.5d.
12. Deploy-time index/TTL provisioning checks. ~0.5d.

## P2 — Product / UX

13. Stream LLM responses (ask/design/plan/build) for perceived speed. ~2d.
14. Source/skill/project delete + edit (only create/patch today). ~2d.
15. Re-learn / refresh source with chunk dedup (ties into deep ingest). ~1d.
16. Project ingest progress UI (depends on async ingestion). ~1d.
17. Pagination for sources/skills/projects/logs. ~1d.

## P2 — Growth

18. Usage metering per user (tokens, ingests) → billing tiers. ~3d.
19. Team/workspace sharing of topics/skills. ~1w.
20. More providers (Anthropic, Azure OpenAI) via the existing provider contract.
    ~2d each.

---

### Suggested sequencing
- **Sprint 1 (P0):** 1–4 — close the core product gap (BUILD + self-learning +
  skills v2 + deep ingest).
- **Sprint 2 (P1):** 5–9 — vector index, async ingest, and remaining security
  hardening.
- **Sprint 3 (P1/P2):** observability (10–12), then UX/growth.
