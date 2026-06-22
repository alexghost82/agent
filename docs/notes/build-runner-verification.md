# Build runner verification (`BUILD_EXEC_ENABLED`)

Engineering note for the gated, real **build-verification** pipeline (Epic 4 /
CONTRACT v3.1). It documents what the flag unlocks, the isolation/safety model,
how to run it locally and in CI, and the risks.

## What `BUILD_EXEC_ENABLED` unlocks

The "verified build" feature generates real project files and then **verifies**
them via `verifyBuild()` in `functions/src/sandbox.ts`:

- **Default (flag unset):** only *static, safe* checks run (`functions/src/pure.ts`
  → `staticBuildChecks`): files present, paths safe (no `..`/abs), JSON parses,
  a recognizable entry/manifest is present, plus a sandbox-containment check.
  **No generated code is ever executed.** This is what the shared `api` process
  runs.
- **With `BUILD_EXEC_ENABLED=1` (or `true`):** `verifyBuild` additionally runs a
  **real toolchain** over the materialized files (`runToolchain`):
  1. `deps_install` — `npm install --offline --no-audit --no-fund --ignore-scripts
     --no-package-lock` (only if the manifest declares dependencies),
  2. `tsc --noEmit` — only if a `tsconfig.json` was produced,
  3. `eslint .` — only if an ESLint config was produced,
  4. `npm test --silent` — only if `package.json` declares a `scripts.test`.

  Each tool maps to a `VerificationCheck`; a missing binary is a graceful
  skip (`ok=true`), a timeout is a real failure. Captured stdout/stderr per tool
  is returned as `verification.logs[]` and persisted onto the `build_runs` doc.

A build is **verified/ready** when every check passes: `verifyBuild` returns
`status: "passed"`, and `functions/src/routes/build.ts` records the run as
`status: "ready"`. `BUILD_EXEC_TIMEOUT_MS` (default `120000`) bounds each child
process.

## Isolation / safety model

Real execution of generated code is only safe on an **isolated, disposable
runner** — never the shared API process. Defense-in-depth (all enforced in
`src/sandbox.ts`, unchanged by this note):

- **Ephemeral sandbox dir** — files are materialized under the OS temp dir
  (`ghost-build-*`) and `rm -rf`'d in a `finally`, even on error/timeout.
- **Containment guard** — every write path is `path.resolve`d and must stay
  inside the sandbox dir; escaping paths are skipped and flagged
  (`sandbox_contained` check), on top of `sanitizeArtifactPath`.
- **No shell** — children spawn via `execFile(..., { shell: false })`; no
  string interpolation into a shell.
- **Scrubbed env** — children get only `PATH` plus npm hygiene flags; `HOME`
  and `TMPDIR` are pinned to the sandbox dir. **No inherited secrets** (API
  keys, tokens) are passed through.
- **Offline + no lifecycle scripts** — npm runs strictly offline
  (`npm_config_offline=true`) and installs use `--ignore-scripts`, so a
  malicious `postinstall` cannot execute and nothing reaches the network.
- **No git remote** — nothing is ever pushed to GitHub or any external repo.
- **Resource limits** — a hard per-process timeout (`BUILD_EXEC_TIMEOUT_MS`)
  and a bounded output buffer; logs are truncated before persistence.
- **Ephemeral runner** — the workflow runs on a fresh GitHub-hosted runner that
  is destroyed after the job; `BUILD_EXEC_ENABLED=1` lives only there.

## How to run

### Locally (real toolchain)

From `functions/`:

```bash
# Generated sample fixture (created in a temp dir, verified, cleaned up):
BUILD_EXEC_ENABLED=1 npx tsx scripts/verify-build.ts

# Your own fixture project directory:
BUILD_EXEC_ENABLED=1 npx tsx scripts/verify-build.ts ./path/to/fixture
```

The harness exits non-zero unless verification `status === "passed"`, so it
doubles as a CI gate. Run the gated integration test directly with:

```bash
BUILD_EXEC_ENABLED=1 npx vitest run test/integration-real/build_exec.test.ts
```

Without the flag, the test **self-skips** (`describe.skipIf`) and the harness
prints a warning and runs static-only checks.

### In CI

`.github/workflows/build-verification.yml` — a **separate**, dispatch/schedule-
only workflow (never push/PR). It sets `BUILD_EXEC_ENABLED=1`, installs Node 22 +
`functions` deps (which provide `tsc`/`eslint` for the sandbox), typechecks
`src`, runs the gated test, then runs the harness. It is gated: a manual
`workflow_dispatch` always runs; the scheduled run only proceeds when the
`BUILD_EXEC_RUNNER` secret equals `1`, otherwise it **skips gracefully** with a
warning annotation. A `fixture_path` dispatch input lets you point the harness
at a specific fixture.

## Risks

- **Arbitrary code execution** — `npm test` runs whatever the generated test
  script contains. Mitigated by the isolation model above; still, only enable on
  a throwaway runner, never on shared/production infrastructure.
- **Offline cache misses** — `deps_install` is strictly offline; fixtures with
  uncached dependencies will fail `deps_install` by design (no network
  fallback). Keep fixtures dependency-light or pre-warm the cache.
- **Resource exhaustion** — a runaway build is bounded by the timeout and output
  cap, but pathological fixtures can still consume CPU/disk for the timeout
  window; the `timeout-minutes` job cap is the backstop.
- **Flakiness on toolchain availability** — if `tsc`/`eslint` are not resolvable
  in the sandbox they are skipped (ok), so a green result does not by itself
  guarantee every tool ran; inspect `verification.logs` / checks to confirm.

## Source-change follow-ups

This note + harness + workflow + gated test only *exercise* the existing gated
path; they do not change `src/`. Possible follow-ups (owned elsewhere):

- Add a small allow-list/pre-warmed offline npm cache so dependency-bearing
  fixtures can verify `deps_install` end to end.
- Consider OS-level sandboxing (containers/seccomp/network namespaces) for the
  runner as a stronger boundary than env scrubbing + offline npm.
- Surface `verification.logs` in the build UI for faster triage.
