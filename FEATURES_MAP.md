# FEATURES_MAP.md — Feature Catalog

Quality score legend: 1 (poor) – 5 (excellent). Complexity: L/M/H.

---

## Core features

### F1. Authentication & sessions
- **Description:** Username/password login, scrypt-hashed credentials, random bearer session tokens, on-demand seed users.
- **Files:** `functions/src/auth.ts`, `functions/src/routes/public.ts:14-31`, `app/page.tsx:175-195`.
- **Dependencies:** Firestore `users`, `SEED_USERS` env.
- **User value:** High (gate to everything). **Business impact:** High.
- **Complexity:** M. **Usage:** Every session. **Quality:** 3/5 — solid hashing & timing-safe compare, but no token expiry/rotation, `/login` unthrottled, `ensureSeedUsers()` runs on every login (`public.ts:17`).

### F2. Topics
- **Description:** Named buckets that scope learned knowledge.
- **Files:** `functions/src/routes/topics.ts`, `app/page.tsx:306-314`.
- **User value:** Medium. **Business impact:** Medium. **Complexity:** L. **Quality:** 4/5.

### F3. Learn URL → vector memory (RAG ingest)
- **Description:** Fetches a public URL (SSRF-guarded), strips HTML, chunks, embeds, stores per-user chunks.
- **Files:** `functions/src/routes/sources.ts:28-88`, `functions/src/ssrf.ts`, `functions/src/pure.ts:3-8`.
- **Dependencies:** AI embeddings, Firestore `sources`/`knowledge_chunks`.
- **User value:** High. **Business impact:** High. **Complexity:** M. **Usage:** Frequent.
- **Quality:** 4/5 — good SSRF defense + rate limit (20/min), but synchronous in-request embedding loops; no dedupe.

### F4. Skill extraction
- **Description:** LLM extracts 5–8 reusable engineering skills from a topic's material; also manual skill creation.
- **Files:** `functions/src/routes/skills.ts`, `functions/src/pure.ts:21-32` (`safeJsonArray`).
- **User value:** Medium-High. **Business impact:** Medium. **Complexity:** M. **Quality:** 4/5.

### F5. Projects + read-only GitHub ingestion
- **Description:** Register projects; ingest a repo's text files (≤200 files, ≤100KB each) into memory and produce an architecture summary. Never writes to GitHub.
- **Files:** `functions/src/routes/projects.ts`, `functions/src/github.ts`, `functions/src/pure.ts:55-84`.
- **Dependencies:** GitHub REST, per-user `githubToken`, AI.
- **User value:** High. **Business impact:** High. **Complexity:** H. **Usage:** Medium.
- **Quality:** 3/5 — clean idempotent re-ingest, but long synchronous job risks function timeout, and `githubToken` is stored **plaintext** (`projects.ts:79`).

### F6. Ask (RAG Q&A)
- **Description:** Cosine search over the user's memory → LLM answer with cited sources.
- **Files:** `functions/src/routes/ask.ts`, `functions/src/memory.ts`, `functions/src/ai.ts:66-79`.
- **User value:** High. **Business impact:** High. **Complexity:** M. **Quality:** 4/5 (recall capped at 1500 chunks).

### F7. Design generation
- **Files:** `functions/src/routes/design.ts`. Combines project summary + selected skills + memory → design decision; persists to `project_decisions`.
- **User value:** High. **Business impact:** High. **Complexity:** M. **Quality:** 4/5.

### F8. Plan & prompt generation
- **Description:** Produces 3–6 markdown files + 3–6 executor prompts as strict JSON, with a raw-output fallback. Files downloadable, prompts copyable.
- **Files:** `functions/src/routes/plans.ts`, `app/page.tsx:980-1041`, `downloadMd` `app/page.tsx:87-97`.
- **User value:** Very High (the core deliverable). **Business impact:** Very High. **Complexity:** H. **Quality:** 4/5.

### F9. Bring-your-own AI keys (OpenAI/Gemini)
- **Description:** Per-user encrypted (AES-256-GCM) provider keys, provider switching, live key test, masked status (last4 only). Server env key used as fallback.
- **Files:** `functions/src/routes/keys.ts`, `functions/src/crypto.ts`, `functions/src/ai.ts:22-47`, `functions/src/providers/*`, `app/page.tsx:1044-1147`.
- **User value:** High. **Business impact:** High (cost offload + multi-provider). **Complexity:** M-H.
- **Quality:** 5/5 — encrypted at rest, never returned, frozen type contract (`providers/types.ts`), strong tests (`test/crypto.test.ts`, `test/keys.test.ts`). Gap: no max-length on key input (`schemas.ts:58-62`).

### F10. Dashboard / activity log
- **Files:** `functions/src/routes/dashboard.ts`, `functions/src/util.ts:8-21` (`logEvent`).
- **User value:** Medium. **Complexity:** L. **Quality:** 3/5 — `count()` over 8 collections per load; logs unbounded (no TTL).

### F11. UX: i18n (EN/HE+RTL), theming, masked inputs
- **Files:** `app/i18n.ts`, `app/page.tsx:167-173`, `app/icons.tsx`.
- **Quality:** 4/5.

---

## Feature → collection matrix

| Feature | Reads | Writes |
|---|---|---|
| Auth | users | users (sessionToken, lastLoginAt) |
| Topics | topics | topics |
| Learn | topics | sources, knowledge_chunks, agent_logs |
| Skills | topics, knowledge_chunks | agent_skills, agent_logs |
| Projects/GitHub | projects, users | projects, knowledge_chunks, agent_logs |
| Ask | knowledge_chunks | agent_logs |
| Design | projects, agent_skills, knowledge_chunks | project_decisions, agent_logs |
| Plan | projects, agent_skills, project_decisions, knowledge_chunks | generated_plans, agent_logs |
| Keys | users | users (apiKeys), agent_logs |
| Dashboard | all (count) | — |
