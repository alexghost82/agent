# TESTING.md — Test Setup

Testing centers on the backend (`functions/`), with a type-check gate on the web
client. The test runner is **vitest**; integration suites run against the
**Firestore emulator** and self-skip when it is unavailable.

## Layout

```text
functions/
  vitest.config.ts          # node env; include: test/**/*.test.ts
  test/
    crypto.test.ts          # unit: AES-256-GCM round-trip / tamper / wrong-secret
    keys.test.ts            # unit: per-user provider key envelope + validation
    pure.test.ts            # unit: pure helpers (chunking, cosine, etc.)
    ssrf.test.ts            # unit: SSRF guard (private/loopback/metadata ranges)
    helpers/
      env.ts                # test env setup
      harness.ts            # startServer/seedUser/expectError, EMULATOR_AVAILABLE
    integration/            # emulator-gated (describe.skipIf(!EMULATOR_AVAILABLE))
      ask.test.ts  dashboard.test.ts  design.test.ts  lang.test.ts
      plans.test.ts  projects.test.ts  public.test.ts  security.test.ts
      skills.test.ts  sources.test.ts  topics.test.ts
```

## Test tiers

### Unit tests (run anywhere, no emulator)

Pure / crypto / SSRF logic that needs no Firestore:

- `crypto.test.ts` — encrypt/decrypt round-trip, auth-tag tamper rejection,
  wrong-secret failure.
- `keys.test.ts` — provider key envelope storage, prefix validation, length
  bounds.
- `pure.test.ts` — deterministic helpers.
- `ssrf.test.ts` — private/loopback/link-local and cloud-metadata host
  rejection, DNS checks.

### Integration tests (Firestore emulator)

Each router has an integration suite under `test/integration/**`. They:

- start the Express app via the harness and seed owner/other users;
- assert auth (`401`), validation (`400`), ownership/isolation (`404`, no
  cross-tenant leakage), and rate limits (`429`);
- drive AI paths up to the deterministic `no_api_key` boundary (no network);
- assert the stable error envelope `{ error, requestId }` (contract §1).

The suites are gated with `describe.skipIf(!EMULATOR_AVAILABLE)`, and
`security.test.ts` additionally uses runtime capability **probes** so individual
checks auto-activate as the backend ships features (and skip — never hard-fail —
otherwise).

## Running tests

```bash
# Web client type-check (repo root)
npm run typecheck

# Backend build + tests
cd functions
npm run build
npm test          # unit always runs; integration self-skips without the emulator

# Integration with the Firestore emulator (mirrors CI)
KEYS_ENC_SECRET=local-test-secret \
  npx firebase emulators:exec --only firestore --project demo-ghost "npx vitest run"
```

## CI (`.github/workflows/ci.yml`)

Three jobs:

1. **checks** — install deps, `npm run typecheck` (Next.js), a pending-friendly
   frontend lint step, `cd functions && npm run build`, then `npm test`
   (unit; integration suites self-skip without the emulator).
2. **integration** — sets up Java + the Firestore emulator, installs
   `firebase-tools` and `@vitest/coverage-v8` (not persisted to
   `package.json`), and runs the integration suite under
   `firebase emulators:exec` with a **coverage gate** (thresholds: lines 65,
   statements 65, functions 75, branches 60; excludes `index.ts`, `providers/**`,
   `github.ts`, `concurrency.ts`).
3. **secret-scan** — greps the tree for obvious committed secrets (OpenAI,
   GitHub PAT, AWS, private keys), excluding `*.example` and lockfiles.

## Conventions

- Tests are deterministic and offline: no real network or AI calls; AI paths stop
  at the `no_api_key` boundary.
- Cross-tenant isolation is asserted explicitly (user A must never see user B's
  data).
- New backend behavior should ship with matching unit and/or integration tests
  under `functions/test/**` (QA-owned per `docs/CONTRACT.md` §8/§v2.6).
