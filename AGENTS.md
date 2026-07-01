# AGENTS.md

## Cursor Cloud specific instructions

GHOST Agent Builder 2.0 is a Firebase monorepo with one product and three surfaces:
- `app/` — Next.js static web client (dev server on `:3000`).
- `functions/` — Express API exported as Firebase Cloud Functions (Node 22).
- `ios/GhostAgent` — SwiftUI client (not needed for web E2E).

Standard install/build/test/run commands live in `README.md` and `TESTING.md`, and the
scripts are in the root and `functions/` `package.json`. The notes below are only the
non-obvious caveats for this environment.

### Required env files (gitignored — recreate them)
`functions/.env` and `.env.local` are gitignored and are NOT recreated by the startup
update script, but the backend and web client will not work without them. Create them
once per fresh VM:

- `functions/.env`:
  ```
  KEYS_ENC_SECRET=local-dev-master-secret-not-for-prod
  SEED_USERS=Alex:ghost,Omer:ghost
  ALLOWED_ORIGINS=
  ```
- `.env.local`:
  ```
  NEXT_PUBLIC_API_BASE=http://127.0.0.1:5001/agent-9d7c2/us-central1/api
  ```

`KEYS_ENC_SECRET` is mandatory or the backend fails to start. The project id in
`NEXT_PUBLIC_API_BASE` (`agent-9d7c2`, from `.firebaserc`) MUST match the project the
emulators run under, or the web client's API calls 404.

### Running locally
- Build functions before starting emulators: `cd functions && npm run build`.
- Start backend + DB: `npx -y firebase-tools@latest emulators:start --only functions,firestore --project agent-9d7c2`
  (Functions `:5001`, Firestore `:8080`, UI `:4000`). The CLI is unauthenticated and
  prints `MetadataLookupWarning`/"not authenticated" noise — this is harmless for the
  emulators. Java is required and is preinstalled.
- Start web client: `npm run dev` (`:3000`).
- Log in with a seed user: username `Alex`, password `ghost`. The login API field is
  `username` (not `name`).

### AI keys are optional for most flows
No `OPENAI_API_KEY`/`GEMINI_API_KEY` is set by default. Non-AI flows (login, topics,
sources, projects CRUD) work fully offline. AI endpoints (ask/design/plan/build,
embeddings) deliberately return `no_api_key` until a key is added to `functions/.env`.
`/readiness` reports `ai:false` in that state, which is expected locally.

### Tests
- Web: `npm run test:web` (jsdom, no backend).
- Backend unit: `cd functions && npm test` (integration suites self-skip without the emulator).
- Backend integration (mirrors CI): from `functions/`,
  `KEYS_ENC_SECRET=local-test-secret npx -y firebase-tools@latest emulators:exec --only firestore --project demo-ghost "npx vitest run"`.

### Lint caveat
`cd functions && npm run lint` currently exits non-zero due to pre-existing
`@typescript-eslint/no-require-imports` errors in committed source (`telemetry.ts`,
`ssrf.ts`, `pdf.ts`, `render.ts`) — not caused by environment setup. Root `npm run lint`
passes (warnings only).
