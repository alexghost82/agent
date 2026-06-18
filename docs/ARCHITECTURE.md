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

- `users` — credentials (scrypt hash), `sessionToken`, optional `githubToken`,
  plus AI settings (see [AI providers & user keys](#ai-providers--user-keys)):
  - `aiProvider: "openai" | "gemini"` (default `"openai"`).
  - `apiKeys: { openai?, gemini? }` where each entry is an encrypted envelope
    `{ ciphertext, iv, tag, last4, updatedAt }`.
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

## AI providers & user keys

Each user can bring their own OpenAI and/or Gemini API key. The contract is
frozen in `functions/src/providers/types.ts` (types only) and exposed over HTTP
via `/me/api-keys` (see `docs/API.md`).

### Storage model

- Selected provider: `users/{id}.aiProvider` — `"openai" | "gemini"`, default `"openai"`.
- Encrypted keys: `users/{id}.apiKeys.{openai|gemini}` — envelope
  `{ ciphertext, iv, tag, last4, updatedAt }`.
- Encryption: **AES-256-GCM**, master secret from env `KEYS_ENC_SECRET`.
- Raw keys are never persisted and never returned to the client. The HTTP layer
  exposes only `{ configured, last4?, updatedAt? }` per provider.
- Validation on write: OpenAI `^sk-`, Gemini `^AIza`.

### Key resolution flow

Every AI call resolves a usable key for the user's active provider. The user's
own key wins; otherwise the server env key is used as a fallback; otherwise the
call fails with the frozen error `no_api_key`.

```text
AI call (userId)
      |
      v
read users/{id}.aiProvider  (default "openai")
      |
      v
user has apiKeys[provider]? ----yes----> decrypt with KEYS_ENC_SECRET --> use user key  (source: "user")
      |
      no
      |
      v
server env key set?  (OPENAI_API_KEY / GEMINI_API_KEY) ----yes----> use server key  (source: "server")
      |
      no
      |
      v
throw / return error: "no_api_key"
```

### Decision: server-key fallback — YES

We keep a server env key as a fallback (`OPENAI_API_KEY`, optional
`GEMINI_API_KEY`). Rationale: seeded/demo users and existing flows keep working
without each user configuring a key, and there is no regression for the current
single-key deployment. The user key always takes precedence, so users who bring
their own key are billed against and rate-limited by their own account. When
neither a user key nor a server key exists, the call fails fast with
`no_api_key` rather than silently degrading.

## Safety model

- The agent reads GitHub repositories but never modifies them.
- Generated md files and prompts are downloadable artifacts; nothing is applied automatically.
- Secrets stay on the server (AI provider keys, GitHub token); CORS can be restricted via `ALLOWED_ORIGINS`.
- User API keys are encrypted at rest (AES-256-GCM via `KEYS_ENC_SECRET`) and never sent to the client.

## iOS Firebase client

The iOS app is a first-party SwiftUI client for the same Firebase project and
Cloud Functions API used by the web client. It uses Firebase only for app
registration and Authentication; product data continues to flow through the
HTTPS Functions API so the Firestore deny-all client rule remains valid.

```text
iOS app (SwiftUI)
  -> FirebaseApp.configure() from GoogleService-Info.plist
  -> Firebase Auth session (anonymous or provider-backed, target)
  -> Cloud Functions HTTPS API under /api
  -> Firestore via Admin SDK only
```

Architectural defaults for the iOS surface:

- Project zone: `ios/GhostAgent`.
- Bundle ID: `com.ghostagnt.ghost`.
- Minimum deployment target: iOS 17.0.
- UI stack: SwiftUI with Observation-friendly state (`@State` private, injected
  services through environment or initializers).
- Dependency strategy: Swift Package Manager via XcodeGen, with Firebase Apple
  SDK products `FirebaseCore` and `FirebaseAuth`.
- Local API base: emulator Functions URL
  `http://127.0.0.1:5001/<PROJECT_ID>/us-central1/api`.
- Production API base: Firebase Hosting `/api` rewrite or the deployed Functions
  HTTPS URL, selected in the iOS app config.

The iOS app must not use the Firestore client SDK for product data unless a new
Architect-owned ADR changes the security model and QA revalidates rules.
