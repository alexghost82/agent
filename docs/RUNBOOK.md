# RUNBOOK.md — GHOST Agent Builder

Operational runbook: local development, emulators, secrets, environment
variables, and deployment. Owner: **Architect**.

---

## 1. Prerequisites

- **Node.js 22** (Cloud Functions runtime target; see `functions/package.json`).
- **npm** (lockfiles are committed; use `npm ci` for reproducible installs).
- **Java 17+** (JDK) — required by the Firestore emulator for local integration
  tests (`emulators:exec`). macOS: `brew install temurin`; Debian/Ubuntu:
  `sudo apt-get install -y openjdk-17-jre-headless`. Without Java the integration
  suites self-skip (they are gated on `FIRESTORE_EMULATOR_HOST`).
- **Firebase CLI**: use the pinned-on-call form `npx -y firebase-tools@latest`.
- The live project is **`agent-9d7c2`** (Blaze). `.firebaserc` already points to
  it (`firebase use agent-9d7c2`).

---

## 2. Repository layout

| Path | Purpose |
|---|---|
| `app/` | Next.js static client (`output: "export"`). |
| `functions/` | Firebase Cloud Functions (Express `api`). |
| `firebase.json` | Hosting, Functions, Firestore, emulator config. |
| `firestore.rules` | Deny-all client access (defense-in-depth). |
| `firestore.indexes.json` | Composite indexes (see `docs/CONTRACT.md` §5). |
| `out/` | Static export output served by Hosting. |
| `docs/` | Contract, ADRs, API, architecture, this runbook. |

---

## 3. Install

```bash
# root (web client + tooling)
npm ci

# functions (backend)
cd functions && npm ci && cd ..
```

> Root dependencies are pinned (no `latest`) — see `package.json`. Use `npm ci`
> in CI to install exactly from the lockfile.

---

## 4. Environment variables & secrets

Secrets live **only on the server** (Cloud Functions runtime / emulator env).
Never commit real values. Templates:

- Root client: `.env.local.example` → `.env.local`
- Functions: `functions/.env.example` → `functions/.env`

| Variable | Scope | Required | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | functions | yes* | Server fallback OpenAI key. AI endpoints fail (`no_api_key`) without a user or server key. |
| `GEMINI_API_KEY` | functions | optional | Server fallback Gemini key. |
| `KEYS_ENC_SECRET` | functions | yes | Master secret for AES-256-GCM encryption of per-user API keys. Per-user key storage fails without it. |
| `SEED_USERS` | functions | yes | Seed credentials for the small authenticated user set. |
| `ALLOWED_ORIGINS` | functions | optional | Comma-separated CORS allowlist. Empty = reflect any origin (dev only). |
| `NEXT_PUBLIC_API_BASE` | client | optional | API base override; defaults to `/api`. |

\* At least one usable AI key (server **or** per-user) must exist for AI flows.

**Production secret handling:** set runtime secrets via your deployment platform
(e.g. `npx -y firebase-tools@latest functions:secrets:set KEYS_ENC_SECRET` for Gen2 secrets, or env on
your hosting backend). Do not bake secrets into the static client bundle — only
`NEXT_PUBLIC_*` values are safe to expose.

---

## 5. Local development with emulators

The Firebase emulator suite is configured in `firebase.json` (Functions `5001`,
Firestore `8080`, Hosting `5000`, Emulator UI `4000`, `singleProjectMode: true`).

```bash
# 1. Build the static client into out/
npm run build

# 2. Build functions (TypeScript → lib/)
cd functions && npm run build && cd ..

# 3. Start the full emulator suite
npm run firebase:emulators
# → Hosting:  http://localhost:5000
# → Functions:http://localhost:5001
# → UI:       http://localhost:4000
```

For iterative client work you can instead run the Next.js dev server:

```bash
npm run dev    # http://localhost:3000
```

When using the dev server, point the client at the emulated function via
`NEXT_PUBLIC_API_BASE` (e.g. the hosting rewrite at `http://localhost:5000/api`).

---

## 6. Quality gates (run before pushing)

```bash
# root
npm run typecheck      # tsc --noEmit
npm run build          # next build (static export)

# combined (root typecheck + functions build)
npm run check

# functions tests (owned by QA)
cd functions && npm test && cd ..
```

CI (`.github/workflows/ci.yml`, owned by QA) runs typecheck, build, tests, and a
secret scan.

---

## 7. iOS client setup

The native client lives in `ios/GhostAgent` and uses bundle id
`com.ghostagnt.ghost`.

Register or inspect the Firebase iOS app from CLI:

```bash
# Confirm project context.
npx -y firebase-tools@latest use

# List apps and find an existing iOS app id, if one already exists.
npx -y firebase-tools@latest apps:list IOS --project <PROJECT_ID>

# Create the app only if it does not exist yet.
npx -y firebase-tools@latest apps:create IOS "Ghost Agent iOS" \
  --bundle-id com.ghostagnt.ghost \
  --project <PROJECT_ID>

# Fetch Firebase client config; do not hand-download it from Console.
npx -y firebase-tools@latest apps:sdkconfig IOS <APP_ID> \
  --project <PROJECT_ID> > ios/GhostAgent/GhostAgent/GoogleService-Info.plist
```

Build and test:

```bash
cd ios/GhostAgent
xcodegen generate
xcodebuild -list -project GhostAgent.xcodeproj
xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' build
xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' test
```

For local API calls from the simulator, use:

```text
http://127.0.0.1:5001/<PROJECT_ID>/us-central1/api
```

Keep `GoogleService-Info.plist` environment-specific. The checked-in app can be
built without a real plist, but Firebase initialization will report a missing
config until the file is added locally.

---

## 8. Deploy

Deploy order matters: **rules and indexes first**, then functions, then hosting.

```bash
# 0. Authenticate & select project
npx -y firebase-tools@latest login
npx -y firebase-tools@latest use <project-id>

# 1. Firestore rules + indexes (validate indexes first — see §9)
npx -y firebase-tools@latest deploy --only firestore:rules
npx -y firebase-tools@latest deploy --only firestore:indexes

# 2. Functions
cd functions && npm ci && npm run build && cd ..
npx -y firebase-tools@latest deploy --only functions

# 3. Hosting (static export)
npm run build           # regenerates out/
npx -y firebase-tools@latest deploy --only hosting
```

Or everything at once:

```bash
npm run deploy          # npx -y firebase-tools@latest deploy
```

> **Cold-start config:** `minInstances`/`concurrency`/`memory` for the `api`
> function are set **in code** (`functions/src/index.ts`), not in `firebase.json`
> — see `docs/CONTRACT.md` §7. Frozen target: `minInstances=1`, `concurrency=80`,
> `memory=512MiB`.

---

## 9. Verifying Firestore indexes

```bash
# JSON is well-formed
node -e "JSON.parse(require('fs').readFileSync('firestore.indexes.json','utf8'));console.log('indexes ok')"

# CLI parses & lists configured indexes
npx -y firebase-tools@latest firestore:indexes

# Dry-run deploy (no changes applied)
npx -y firebase-tools@latest deploy --only firestore:indexes --dry-run
```

Composite index build can take minutes on first deploy; queries that need them
return `FAILED_PRECONDITION` until the index is `READY`.

---

## 10. Common operations

| Task | Command |
|---|---|
| Tail emulator logs | watch the emulator terminal / `firebase-debug.log` |
| Re-seed users | restart functions with the desired `SEED_USERS` |
| Rotate `KEYS_ENC_SECRET` | re-encrypt stored keys (manual migration; see ADR-0006) |
| Export/backup Firestore | `gcloud firestore export gs://<bucket>` (see ADR-0006) |

---

## 11. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| AI calls return `no_api_key` | no server or user key | set `OPENAI_API_KEY` (functions) or configure a user key |
| Key storage errors | missing `KEYS_ENC_SECRET` | set the secret in functions env |
| Query `FAILED_PRECONDITION` | index missing/building | deploy indexes (§8), wait for `READY` |
| First request slow | cold start | confirm `minInstances` is applied in code (Contract §7) |
| CORS blocked in prod | `ALLOWED_ORIGINS` unset/incorrect | set the comma-separated allowlist |

---

## 12. Ops scripts & v3 operations

Helper scripts live in `scripts/` (wrap `gcloud`/Admin SDK; run from an authed
environment, not CI):

| Script | Purpose |
|---|---|
| `scripts/seed-users.mjs` | Upsert login users from `SEED_USERS` via the Admin SDK. |
| `scripts/enable-ttl.sh` | Enable Firestore TTL on `agent_logs.expireAt` and `rate_limits.expireAt` (ADR-0005). |
| `scripts/backup.sh` | One-off Firestore export to GCS + how to enable daily managed backups (ADR-0006). |

### Vector backend (CONTRACT v3.2)

`VECTOR_BACKEND` selects memory search. Default `memory` (in-process cosine — the
only mode the emulator supports). Set `VECTOR_BACKEND=firestore` in production to
use Firestore Vector Search (`findNearest`); requires the `embedding` vector
field override in `firestore.indexes.json` (deploy indexes first) and embeddings
written as vector values. Recall is no longer bounded by `VECTOR_CANDIDATE_CAP`.

### Build verification (CONTRACT v3.1)

`POST /projects/:id/build` materializes artifacts into an ephemeral OS-temp
sandbox and runs **static, safe** checks by default (`verification` report). It
never executes generated code and never writes to any git remote.

When `BUILD_EXEC_ENABLED=1`, `sandbox.ts` additionally runs a **real toolchain**
over the generated files inside the sandbox dir — `tsc --noEmit` (only if a
`tsconfig.json` was generated), eslint (only if an eslint config was generated),
and the project's `npm test` (only if `package.json` declares a test script).
Each child process runs with `cwd` pinned to the sandbox, a hard timeout
(`BUILD_EXEC_TIMEOUT_MS`), a scrubbed env (no inherited secrets), `shell:false`,
and bounded captured logs. Results (passed/failed + truncated logs) are stored on
`build_runs.verification`. This path is for an **isolated runner only** (e.g. a
dedicated Cloud Run job) — never enable it on the shared `api` instance, which is
why production leaves `BUILD_EXEC_ENABLED` unset.

### Sessions, roles & user management (SECURITY v2)

- **Cookie sessions:** `/login`, `/auth/firebase`, and `/accept-invite` set an
  `httpOnly; Secure; SameSite=Strict` `gh_session` cookie in addition to the
  JSON `token`. `requireAuth` accepts either the `Authorization: Bearer` header
  (native/iOS) or the cookie (web). Because Hosting rewrites `/api/**` to the
  function, the browser and API are same-origin, so SameSite=Strict is sent on
  same-origin XHR while blocking cross-site (CSRF) sends. Logout / password
  change clear the cookie and invalidate the server session.
- **Roles:** users carry `role` (`admin`|`member`); seed users are `admin`.
  `requireRole("admin")` gates the admin routes.
- **Invites:** `POST /invites` (admin) issues a single-use, expiring code; the
  invitee redeems it at the public `POST /accept-invite` to create an account.
  `GET /users`, `PATCH /users/:id/role` (admin) manage users; the last admin
  cannot be demoted.

### Async ingest (ADR-0002) — ENABLED

`POST /projects/:id/connect-github` no longer runs ingestion synchronously. It
validates ownership, marks the project `ingestStatus="queued"` with a per-request
`ingestToken`, enqueues a Cloud Tasks job and returns `202 {status:"queued"}`.

- Worker: `ingestWorker` (`functions/src/tasks.ts`, exported from `index.ts` as a
  `onTaskDispatched` v2 function). Retries with exponential backoff
  (`maxAttempts:5`, 30s→300s); permanent GitHub errors (repo unavailable / access
  denied) are not retried. Progress + final state are written to `projects/{id}`.
- Idempotency: the `ingestToken` makes re-submission safe — a stale/retried task
  that has been superseded by a newer request is dropped, and `ingestRepo` deletes
  prior chunks before re-indexing so re-runs never duplicate data.
- Local/emulator/tests: Cloud Tasks is unavailable, so `tasks.ts` runs the job
  out-of-band on the next tick (`INGEST_INLINE` controls this: `1`=inline,
  `0`=no-op test seam). In production the real Cloud Tasks queue is used.
- The Cloud Tasks API is enabled automatically on first `firebase deploy` of the
  worker (Blaze required — confirmed on `agent-9d7c2`).

### Error tracking

`sendError` logs every 5xx at `error` level with the `requestId` and stack as a
single-line JSON record. On GCP these are automatically ingested by **Cloud Error
Reporting** (no SDK needed). For richer tracing, set `SENTRY_DSN` and add the
Sentry SDK as a follow-up; the structured-log channel is the default.

### Deployed environment — agent-9d7c2 (Blaze)

Live deployment, verified via Firebase CLI/MCP on 2026-06-19:

| Item | Value / status |
|---|---|
| Project | `agent-9d7c2` (Blaze) |
| Firestore | Native, location `nam5`, `(default)` — **exists** |
| Hosting | https://agent-9d7c2.web.app (`/api/**` → `api` function) |
| Function `api` | deployed (Gen2, Node 22, `us-central1`); URL `https://api-jpfec4kova-uc.a.run.app` |
| Function `ingestWorker` | deployed (Cloud Tasks worker; Cloud Tasks API enabled) |
| Rules | `firestore.rules` (deny-all) released |
| Indexes | composite indexes deployed; **vector** composite indexes on `knowledge_chunks` (`userId+embedding`, `userId+projectId+embedding`, `userId+topicId+embedding`, dim 1536) created via the Firestore Admin API |
| `VECTOR_BACKEND` | `firestore` (set in `functions/.env.agent-9d7c2`) |
| `NEXT_PUBLIC_API_BASE` | not set → defaults to `/api`, which is correct because Hosting serves the client and rewrites `/api` to the function (same origin) |

**Runtime secrets** live in the gitignored `functions/.env.agent-9d7c2`
(`KEYS_ENC_SECRET`, `SEED_USERS`, `VECTOR_BACKEND`). They are loaded by
`firebase deploy` (logged as "Loaded environment variables from .env,
.env.agent-9d7c2"). Rotate by editing that file and redeploying functions.

> **AI keys are NOT set** (none were available at deploy time). `/api/readiness`
> returns `503 {ai:false}` and AI endpoints return `no_api_key` until the owner
> sets `OPENAI_API_KEY`/`GEMINI_API_KEY` in `functions/.env.agent-9d7c2` (then
> redeploy) **or** enters a per-user key in Settings (encrypted with the current
> `KEYS_ENC_SECRET`). Any per-user key stored under a previous secret must be
> re-entered, and any previously committed key must be rotated.

> **Vector indexes** may briefly show `CREATING`; confirm `READY` before relying
> on `findNearest`:
> ```bash
> npx -y firebase-tools@latest firestore:indexes --project agent-9d7c2
> ```

#### TTL & backups (require gcloud auth)

`scripts/enable-ttl.sh` and `scripts/backup.sh` wrap `gcloud`/Firestore Admin and
must be run from a `gcloud auth login`-authenticated shell (the Firebase CLI
token is not sufficient):

```bash
gcloud auth login
gcloud config set project agent-9d7c2
bash scripts/enable-ttl.sh      # TTL on agent_logs.expireAt + rate_limits.expireAt
bash scripts/backup.sh          # one-off export + daily managed backup schedule
```

These were **not** executed automatically (the deploy environment had only the
Firebase CLI authenticated, not gcloud). Run them once as the project owner.

### Usage accounting (CONTRACT v3.7)

`usage/{userId}_{YYYY-MM}` accumulates per-user monthly counters
(`ask`/`design`/`plan`/`build`/`ingest`). Advisory only today (no enforcement);
the data backs future tariffs/quotas.
