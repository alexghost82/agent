# Integration Plan — 4-Wave Hardening Orchestration

> **Status:** authoritative merge/integration runbook for the 16-workstream,
> 4-wave parallel hardening effort. Authored by workstream **P**
> (`feature/changelog-discipline`). Documentation only — no source changes.
> Date: 2026-06-22. Base branch: `main` (`ef6837d`).

This document defines (1) the recommended **merge order** respecting the dependency
chain, (2) the **file-ownership matrix** that proves the branches are conflict-safe
when merged in order, (3) the **cross-cutting follow-ups** with owners and priority,
and (4) the **post-merge verification checklist**.

All commit SHAs below were verified against the feature branches with
`git log --oneline -1 feature/<branch>`.

---

## 1. Workstream inventory

| ID | Branch | Commit | Depends on | Wave |
|---|---|---|---|---|
| A | `feature/vector-backend` | `b91c0aa` | — | 1 |
| B | `feature/ssrf-hardening` | `f89ac63` | — | 1 |
| C | `feature/app-check` | `d073f97` | — | 1 |
| D | `feature/eslint-gate` | `b430f44` | — | 1 |
| E | `feature/embedding-dimension` | `94a767a` | A | 2 |
| F | `feature/runtime-optimization` | `c7abbeb` | C | 2 |
| G | `feature/pagination` | `190a811` | — | 2 |
| H | `feature/coverage-improvement` | `0a335a8` | D | 2 |
| I | `feature/observability` | `e51d68b` | A | 3 |
| J | `feature/alerting` | `c333e47` | — | 3 |
| K | `feature/firestore-validation` | `638eba7` | A | 3 |
| L | `feature/ios-e2e` | `c058d59` | — | 3 |
| M | `feature/key-rotation` | `69f5f20` | — | 4 |
| N | `feature/build-runner-verification` | `061f349` | — | 4 |
| O | `feature/firestore-backups` | `b9f8e4f` | — | 4 |
| Q | `feature/conventional-commits` | `17ef141` | H | 4 |
| P | `feature/changelog-discipline` | _this branch_ | all (docs) | 4 |
| — | `cursor/fix-root-tsconfig-exclude-functions` | `b191ff8` (origin: `…-5da7`) | — | fix |

Dependency chains: **A → {E, I, K}**, **C → F**, **D → H → Q**. Independents:
**B, G, J, L, M, N, O** (and the docs branch **P**, plus the root tsconfig fix).

---

## 2. Recommended merge order

Merge into `main` (or an `integration` branch) in this order. The order honors every
dependency (a branch is only merged after its base) and sequences the few
shared-file touch-points (see §3) so each merge is additive.

1. **A** `feature/vector-backend` — base of the vector stack.
2. **B** `feature/ssrf-hardening` — independent, isolated to `ssrf.ts`.
3. **C** `feature/app-check` — base of F; touches `index.ts`, `auth.ts`.
4. **D** `feature/eslint-gate` — base of H; adds the lint CI gate + root config.
5. **`cursor/fix-root-tsconfig-exclude-functions`** (`b191ff8`) — **P0**, merge
   here so the root `typecheck` step is green before coverage/test branches land
   (see follow-up #1). May be merged first if preferred.
6. **E** `feature/embedding-dimension` (←A) — `ai.ts`, `learn.ts`, `firestore.indexes.json`.
7. **F** `feature/runtime-optimization` (←C) — `index.ts` runtime opts.
8. **I** `feature/observability` (←A) — `telemetry.ts`, `log.ts`, `memory.ts`,
   `functions/package.json` (OTel deps). Reconcile `index.ts` with C/F (additive).
9. **K** `feature/firestore-validation` (←A) — all-new workflow/test/script files.
10. **G** `feature/pagination` — `listing.ts`, `routes/{topics,sources}.ts`.
11. **H** `feature/coverage-improvement` (←D) — raises coverage thresholds in
    `ci.yml`; new tests. Merge after the tsconfig fix.
12. **J** `feature/alerting` — all-new `monitoring/**`.
13. **L** `feature/ios-e2e` — all-new `ios/**` + parity notes.
14. **M** `feature/key-rotation` — `crypto.ts`, new script + notes.
15. **N** `feature/build-runner-verification` — all-new workflow/test/script files.
16. **O** `feature/firestore-backups` — `ADR-0006`, `infra/**`, new workflow.
17. **Q** `feature/conventional-commits` (←H) — adds `commit-lint` CI job; merge
    after D and H so the `ci.yml` job list is additive.
18. **P** `feature/changelog-discipline` — docs sync (this branch); merge **last**
    so the changelog/audit/security/ADR index reflect the final merged state.

> **Rationale for sequencing shared files:** `ci.yml` is edited by D (lint gate),
> H (coverage thresholds), and Q (commit-lint job) — merging **D → H → Q** keeps
> each change additive. `functions/src/index.ts` is edited by C (CORS + App Check),
> F (runtime opts), and I (`initTelemetry()` wiring) — merging **C → F → I** lets
> each layer apply cleanly. `functions/package.json` is edited by I (OTel deps) and
> dev-tooling branches — resolve by union of dependency entries.

---

## 3. File-ownership matrix (conflict analysis)

Most branches own disjoint files and **cannot conflict**. The few shared
touch-points are listed explicitly with the resolution strategy.

### 3a. Uniquely owned (no overlap)

| Branch | Primary files (sole owner) |
|---|---|
| A | `functions/src/memory.ts`, `functions/src/pure.ts`, `docs/adr/ADR-0001-*`, `docs/notes/vector-migration.md`, `functions/test/integration/vector_backend.test.ts` |
| B | `functions/src/ssrf.ts`, `functions/test/ssrf.test.ts` |
| E | `functions/src/ai.ts`, `functions/src/learn.ts`, `firestore.indexes.json`, `docs/adr/ADR-0008-*` |
| G | `functions/src/listing.ts`, `functions/src/routes/topics.ts`, `functions/src/routes/sources.ts` |
| J | `monitoring/**` (all new) |
| K | `.github/workflows/vector-validation.yml`, `functions/test/integration-real/vector_real.test.ts`, `functions/scripts/seed-vector-fixtures.ts`, `docs/notes/vector-real-validation.md` |
| L | `ios/**`, `docs/notes/ios-api-parity.md` |
| M | `functions/src/crypto.ts`, `functions/test/crypto.test.ts`, `functions/scripts/rotate-keys.ts`, `docs/notes/key-rotation.md` |
| N | `.github/workflows/build-verification.yml`, `functions/test/integration-real/build_exec.test.ts`, `functions/scripts/verify-build.ts`, `docs/notes/build-runner-verification.md` |
| O | `docs/adr/ADR-0006-*`, `infra/firestore-backups/**`, `.github/workflows/firestore-backup.yml` |
| P | `SECURITY_REPORT.md`, `PROJECT_AUDIT.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/notes/integration-plan.md` |
| tsconfig-fix | root `tsconfig.json` |

### 3b. Shared files — sequenced, additive (resolution required)

| File | Branches | Resolution |
|---|---|---|
| `.github/workflows/ci.yml` | D, H, Q | Merge **D → H → Q**: D adds the lint hard-fail gate, H raises coverage thresholds (85/85/85 + 75 branches), Q adds the additive `commit-lint` job. Each touches a distinct region; review the final job list once. |
| `functions/src/index.ts` | C, F, I | Merge **C → F → I**: C adds the CORS allow-list + App Check middleware, F changes the `runWith`/runtime options + cold-start guard, I adds the `initTelemetry()` call at the top + HTTP instrumentation (follow-up #5). Distinct regions; verify the top-of-file `initTelemetry()` lands before app construction. |
| `functions/src/auth.ts` | C | Sole owner (App Check helper). No conflict. |
| `functions/package.json` | I (OTel deps), root tooling (D/H/Q at root `package.json`) | I edits **`functions/package.json`** (OTel runtime deps); D/H/Q edit the **root** `package.json`. Different files — union-merge dependency blocks. |
| root `package.json` | D, H, Q | Additive devDependencies/scripts (eslint, commitlint, husky). Union-merge. |
| `docs/adr/README.md` | P | Sole owner (this branch updates the index for ADR-0001/0006/0008). No conflict. |

> **Conclusion:** with the order in §2, there are **no true content conflicts** —
> only additive edits to `ci.yml`, `functions/src/index.ts`, and the two
> `package.json` files, all resolvable by sequencing + union-merge.

---

## 4. Cross-cutting follow-ups

Priority key: **P0** = merge blocker / must fix before relying on the system;
**P1** = required before production rollout; **P2** = scheduled hardening.

| # | Item | Owner | Priority | Recommended fix |
|---|---|---|---|---|
| 1 | **Root typecheck broken** — root `tsconfig` `**/*.ts` glob sweeps `functions/test/**` (e.g. H's `providers_unit.test.ts`), so `npm run typecheck` fails. | Build/Infra | **P0** | Merge `cursor/fix-root-tsconfig-exclude-functions` (`b191ff8`) which adds `functions/**` to the root tsconfig `exclude`. Land early (step 5 of §2). |
| 2 | **Deployed default backend** — A makes Firestore the code default, but confirm `VECTOR_BACKEND=firestore` is set in prod env after all branches merge (F's branch alone still saw the memory default since it only merged C). | Backend / Ops | **P1** | Set `VECTOR_BACKEND=firestore` in the deployed function config; verify post-merge that the resolver picks firestore outside the emulator. |
| 3 | **Embedding back-population** — existing 768-dim Gemini chunks must be re-normalized to 1536 (run E's `normalizeEmbedding` over stored vectors + rewrite as `FieldValue.vector`) before relying on the vector index. In-memory fallback covers them meanwhile. | Backend (E) | **P1** | Write/run a one-off migration over `knowledge_chunks`; until then the per-request fallback to in-memory cosine keeps results correct. |
| 4 | **Metric-name reconciliation** — J's AlertPolicies use placeholder OTel metric names; align to I's actual names: `vector_search_ms`, `vector_search_fallback_total`, `http_server_request_ms`, `errors_total`. | Observability (J ↔ I) | **P1** | Update `monitoring/**` policy filters to the real metric descriptors once telemetry is deployed. |
| 5 | **`initTelemetry()` wiring** — I's full HTTP auto-instrumentation needs `initTelemetry()` called at the very top of `index.ts` (manual spans/metrics already work). | Backend (I) | **P1** | Add the call as the first statement in `functions/src/index.ts` (before app/import side-effects), per §3b. |
| 6 | **`recordError` adoption** — routes should call `recordError` in `catch` blocks for `errors_total` coverage. | Backend | **P2** | Thread `recordError(err)` through route error handlers / the central error envelope in `errors.ts`. |
| 7 | **iOS contract bugs (from L)** — `DashboardResponse.Counts` uses wrong keys (`chunks`/`skills`/… vs `knowledge_chunks`/`agent_skills`/…); `AgentLog.createdAt` can't decode a Firestore `Timestamp`; `user.role` dropped on login. Backend untouched. | iOS | **P1** | Fix decoding keys + `Timestamp` handling + preserve `role` on the iOS side; backend contract is correct. |
| 8 | **App Check rollout** — web client must initialize the App Check SDK + send `X-Firebase-AppCheck` before flipping `APP_CHECK_ENFORCE=enforce`; consider dedicated error codes in `errors.ts`. | Frontend / Backend (C) | **P1** | Ship client App Check init, validate traffic in `warn`, add App Check error codes, then enforce. |
| 9 | **`tsx` devDependency** — M's and N's scripts use `npx tsx` but `tsx` isn't a declared devDependency. | Build/Infra | **P2** | Add `tsx` to `functions/package.json` devDependencies (pin a current version). |
| 10 | **Pagination rollout** — migrate remaining list endpoints (projects, plans, build, memory, agent, design, dashboard) to `listScopedPage`. | Backend (G) | **P2** | Thread `listScopedPage()` additively into the remaining routes, mirroring `/topics` & `/sources`. |

---

## 5. Post-merge verification checklist

Run after completing the §2 merge order (from repo root unless noted):

- [ ] **Install** — `cd functions && npm install` (and root `npm install` for lint/commitlint tooling).
- [ ] **Typecheck (after tsconfig fix #1)** — `npm run typecheck` passes at root; `functions/**` excluded.
- [ ] **Build** — `cd functions && npm run build` succeeds.
- [ ] **Lint gate (D)** — root `npm run lint` (eslint flat config) passes as a hard-fail gate.
- [ ] **Unit tests + coverage gate (H)** — `cd functions && npm test` meets **85/85/85** lines/stmts/funcs + **75** branches.
- [ ] **Emulator integration (A)** — vector backend integration test passes against the Firestore emulator (auto-falls back to in-memory cosine).
- [ ] **Real vector validation (K)** — `vector-validation.yml` (dispatch/schedule-only) green against real Firestore; self-skips otherwise.
- [ ] **Real build verification (N)** — `build-verification.yml` green when `BUILD_EXEC_ENABLED`; self-skips otherwise.
- [ ] **Commitlint (Q)** — `commit-lint` CI job + husky `commit-msg` hook validate Conventional Commits.
- [ ] **Runtime config (F, #2)** — confirm `1GiB`/concurrency-60 and `VECTOR_BACKEND=firestore` in deployed env.
- [ ] **Telemetry wiring (#5)** — `initTelemetry()` at top of `index.ts`; spans/metrics flow to Cloud Trace/Monitoring.
- [ ] **Alerts (J, #4)** — AlertPolicy metric filters reconciled to I's metric names.
- [ ] **Backups (O)** — `infra/firestore-backups` applied; daily/weekly schedules + GCS export verified.
- [ ] **Embedding back-population (#3)** — migration run (or fallback acknowledged) before relying on the vector index.
- [ ] **Docs (P)** — `CHANGELOG.md`, `PROJECT_AUDIT.md`, `SECURITY_REPORT.md`, and the ADR index reflect the merged state.

---

## 6. References

- ADRs: [ADR-0001 (Vector Search)](../adr/ADR-0001-vector-search.md),
  [ADR-0006 (Firestore backups)](../adr/ADR-0006-firestore-backups.md),
  [ADR-0008 (Embedding dimension)](../adr/ADR-0008-embedding-dimension.md),
  and the [ADR index](../adr/README.md).
- Reports: [`PROJECT_AUDIT.md`](../../PROJECT_AUDIT.md),
  [`SECURITY_REPORT.md`](../../SECURITY_REPORT.md),
  [`CHANGELOG.md`](../../CHANGELOG.md).
- Workstream notes (land with their branches): `docs/notes/vector-migration.md` (A),
  `docs/notes/runtime-load-test.md` (F), `docs/notes/observability.md` (I),
  `docs/notes/vector-real-validation.md` (K), `docs/notes/ios-api-parity.md` (L),
  `docs/notes/key-rotation.md` (M), `docs/notes/build-runner-verification.md` (N),
  `docs/notes/conventional-commits.md` (Q).
