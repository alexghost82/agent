# API

All endpoints are served by Firebase Functions under `/api`. Every endpoint
except `GET /health` and `POST /login` requires `Authorization: Bearer <token>`
(the token returned by `/login`). All data is isolated per user.

## Basic

- `GET /health`
- `POST /login` -> `{ token, user }`
- `POST /logout` -> `{ ok: true }`
- `GET /readiness` -> `{ ok, checks: { firestore, ai } }`
- `GET /dashboard` (counts + recent logs for the current user)

## Native iOS client

The iOS app uses the same HTTPS API surface as the web app. For local simulator
development, point the app at:

```text
http://127.0.0.1:5001/<PROJECT_ID>/us-central1/api
```

For production, use the deployed Functions URL or Firebase Hosting `/api`
rewrite. Protected calls currently use the bearer returned by `POST /login`:

```http
Authorization: Bearer <token>
```

Firebase Auth is initialized in the app so the Firebase Console recognizes the
iOS application and the app can migrate to Firebase ID tokens once Backend adds
server-side verification for that transport. Until then, iOS must not call
Firestore directly.

## Topics & sources

- `POST /topics` `{ name, description? }`
- `GET /topics`
- `POST /learn` `{ topicId, url, tags? }` (SSRF-guarded fetch + embedding)
- `GET /sources?topicId=`

## Skills

- `POST /extract-skills` `{ topicId }` (generates skills from a topic's knowledge)
- `POST /skill` `{ topicId, skillName, description, example? }` (manual)
- `GET /skills?topicId=`

## Projects & GitHub (read-only)

- `POST /projects` `{ name, description, stack?, repoUrl? }`
- `GET /projects`
- `PATCH /projects/:id` `{ skillIds?, name?, description?, stack?, repoUrl? }`
- `POST /github-token` `{ token }` (stored server-side only)
- `POST /projects/:id/connect-github` `{ repoUrl }`
  - Read-only: GET requests to the GitHub API only. The agent never writes to the repo.

## AI provider & API keys

Each user brings their own OpenAI and/or Gemini API key. Raw keys are stored
**encrypted** (AES-256-GCM, server master secret `KEYS_ENC_SECRET`) and are
**never** returned to the client — only a masked status (`configured`, `last4`,
`updatedAt`) is exposed. Validation: OpenAI keys must match `^sk-`, Gemini keys
must match `^AIza`.

The shared status object (returned by both `GET` and `PUT`):

```json
{
  "provider": "openai",
  "keys": {
    "openai": { "configured": true,  "last4": "a1b2", "updatedAt": "2026-06-17T10:15:00.000Z" },
    "gemini": { "configured": false }
  }
}
```

- `GET /me/api-keys` -> status object above (`provider` + per-provider `{ configured, last4?, updatedAt? }`).
- `PUT /me/api-keys` `{ openai?: string|null, gemini?: string|null, provider?: "openai"|"gemini" }` -> same status object.
  - A `string` sets/replaces the raw key (validated, then encrypted server-side).
  - `null` deletes the stored key for that provider.
  - An omitted field leaves the existing key untouched.
- `POST /me/api-keys/test` `{ provider: "openai"|"gemini" }` -> `{ ok: boolean, error? }`
  - Live-tests the resolved key (user key, else server fallback) for the provider.

Key resolution for any AI call: the user's key for the active `aiProvider`, else
the server env key (`OPENAI_API_KEY` / `GEMINI_API_KEY`), else error `no_api_key`.
See `docs/ARCHITECTURE.md` for the resolution flow.

## Ask

- `POST /ask` `{ question, limit? }`

## Design

- `POST /design` `{ projectId, section? }`
- `GET /design?projectId=`

## Plan

- `POST /generate-plan` `{ projectId, instructions? }` -> `{ files: [{path, content}], prompts: [{title, content}] }`
- `GET /generated-plans?projectId=`
