# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project now
enforces [Conventional Commits](https://www.conventionalcommits.org/) via
commitlint (see `feature/conventional-commits`).

## [Unreleased] — 2026-06-22 — 4-Wave Hardening Orchestration

Sixteen parallel workstreams (each a committed feature branch, ready for merge).
Commit SHAs are noted per item; the merge order and follow-ups live in
[`docs/notes/integration-plan.md`](docs/notes/integration-plan.md).

### Added

- **Firestore Vector Search as the default similarity backend** with emulator
  auto-fallback and per-request graceful fallback to in-memory cosine on
  `findNearest` error; real COSINE scores. (`feature/vector-backend`, `b91c0aa`)
- **Canonical embedding dimension** via `normalizeEmbedding()` to a configurable
  `TARGET_EMBED_DIM` (default 1536; avg-pool/zero-pad + L2-renorm) so 768-dim
  (Gemini) and 1536-dim (OpenAI) vectors share one index. (`feature/embedding-dimension`, `94a767a`)
- **Keyset cursor pagination** — `listScopedPage()` returning `{items, nextCursor}`
  with an opaque base64url cursor and id tie-break, threaded additively into
  `/topics` and `/sources`. (`feature/pagination`, `190a811`)
- **OpenTelemetry tracing + metrics** to Google Cloud Trace/Monitoring (no-op in
  test/emulator), including a vector-search span and the metrics
  `vector_search_ms`, `vector_search_fallback_total`, `http_server_request_ms`,
  `errors_total`, plus a `recordError` hook. (`feature/observability`, `e51d68b`)
- **Encryption key versioning & rotation** — optional `v` on `EncryptedSecret`,
  an idempotent dry-run migration script, and a rotation runbook; fully
  backward-compatible. (`feature/key-rotation`, `69f5f20`)
- **iOS ↔ backend API parity test suite** — parity matrix, XCTest (19/19), and a
  no-Xcode node contract check (13/13). (`feature/ios-e2e`, `c058d59`)

### Changed

- **`api` Cloud Function runtime** tuned from 2GiB/concurrency-8 to
  1GiB/concurrency-60 (env-overridable) with a cold-start guard — ~14× lower
  memory-billed cost. (`feature/runtime-optimization`, `c7abbeb`)

### Security

- **Closed redirect-follow SSRF** — manual redirect handling with per-hop
  revalidation and a 5-hop cap. (`feature/ssrf-hardening`, `f89ac63`)
- **Closed DNS-rebinding TOCTOU** — verified-IP pinning via an undici dispatcher
  preserving Host/SNI. (`feature/ssrf-hardening`, `f89ac63`)
- **Removed reflect-all dev CORS** in favor of an explicit localhost allow-list.
  (`feature/app-check`, `d073f97`)
- **Added staged Firebase App Check** (off/warn/enforce; default warn, emulator
  bypass) on the authed section. (`feature/app-check`, `d073f97`)

### CI

- **ESLint flat config** (`eslint.config.mjs`, eslint-config-next 16) with lint as
  a **mandatory hard-fail** CI gate. (`feature/eslint-gate`, `b430f44`)
- **Coverage gate raised to 85/85/85** lines/stmts/funcs + 75 branches, backed by
  new suites covering `providers/**`, `github.ts`, `concurrency.ts`.
  (`feature/coverage-improvement`, `0a335a8`)
- **Real Firestore `findNearest` validation pipeline** — dispatch/schedule-only
  workflow + self-skipping real test + seed/cleanup script. (`feature/firestore-validation`, `638eba7`)
- **Gated real build-verification pipeline** (`BUILD_EXEC_ENABLED`) — separate
  workflow + self-skipping real test + harness. (`feature/build-runner-verification`, `061f349`)
- **Cloud Monitoring AlertPolicies** (JSON + Terraform) for OOM, 5xx error-rate,
  p95 latency, and vector fallback. (`feature/alerting`, `c333e47`)
- **Managed Firestore backups** — Terraform for daily (7d) / weekly (14w) backups +
  scheduled GCS export (30d) with a least-privilege exporter SA + optional
  dispatch-only workflow. (`feature/firestore-backups`, `b9f8e4f`)
- **Conventional Commits enforcement** — commitlint config, an additive
  `commit-lint` CI job, and a husky `commit-msg` hook. (`feature/conventional-commits`, `17ef141`)

### Docs

- ADR-0001 updated (Vector Search implemented), ADR-0006 implemented (Firestore
  backups), and ADR-0008 added (embedding dimension); synchronized
  `PROJECT_AUDIT.md`, `SECURITY_REPORT.md`, the ADR index, and the new
  `docs/notes/integration-plan.md` merge runbook. (`feature/changelog-discipline`)

## 2.0.0

Changed:

- per-user data isolation (every document scoped by `userId`);
- enforced Bearer-token auth on all endpoints;
- topics that group sources and produce skills;
- read-only GitHub project understanding (never writes to the repo);
- project skill selection;
- Design Platform now works per project (with optional section);
- new Plan step that generates md files and agent prompts.

Removed:

- Approvals, Review and Generate code steps/endpoints.

Security:

- scrypt password hashing, seed users from env;
- SSRF guard on URL fetching;
- rate limiting on heavy endpoints;
- Firestore rules deny direct client access;
- CI secret scan and functions tests.

## 1.0.0-pro

Initial PRO release: backlog tasks, approvals, critic-before-action, reviewer,
security review, dashboard, agent logs, docs, GitHub CI workflow.
