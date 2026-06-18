# RUNBOOK.md — GHOST Agent Builder

Operational runbook: local development, emulators, secrets, environment
variables, and deployment. Owner: **Architect**.

---

## 1. Prerequisites

- **Node.js 22** (Cloud Functions runtime target; see `functions/package.json`).
- **npm** (lockfiles are committed; use `npm ci` for reproducible installs).
- **Firebase CLI**: use the pinned-on-call form `npx -y firebase-tools@latest`.
- A Firebase project. Copy `.firebaserc.example` → `.firebaserc` and set your
  project id, or run `npx -y firebase-tools@latest use <project-id>`.

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
