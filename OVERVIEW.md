# GHOST Agent Builder 2.0 — Overview

GHOST is a multi-tenant AI agent that turns research into software designs. It
**learns** from URLs and GitHub repositories (read-only), **remembers** the
material in vector memory, **extracts reusable skills**, and then **designs** and
**plans** projects. A **BUILD** mode (landing now) generates real project files
into a Firestore-backed workspace for review and download — it never writes to
GitHub or any external repository.

## What it does

| Capability | Summary |
|---|---|
| Learn | Study a URL or GitHub repo behind an SSRF guard; chunk, embed, store. |
| Remember | Owner-scoped vector recall over `knowledge_chunks`. |
| Skill | Extract reusable skills from a topic's knowledge. |
| Design | Produce a project design/architecture from idea + memory. |
| Plan | Produce Markdown plans and agent prompts. |
| Build | Generate real files into a Firestore workspace, downloadable client-side. |

The product loop:

```text
learn  →  remember  →  skill  →  design  →  plan  →  BUILD
```

## Shape of the system

- **Web client** — Next.js static export (`output: "export"`) in `app/`, with
  i18n for EN/HE/RU. Served by Firebase Hosting.
- **Backend** — a single Express app (Node 22) exported as the `api` Firebase
  Cloud Function in `functions/`. One router per area under
  `functions/src/routes/*`.
- **iOS client** — native SwiftUI app in `ios/GhostAgent` that talks to the same
  Functions HTTPS API.
- **Storage** — Firestore via the Admin SDK only. Client access is deny-all
  (`firestore.rules`); all product data is server-mediated.
- **AI** — pluggable OpenAI / Gemini providers; users may bring their own key
  (encrypted at rest), with a server env key as fallback.

## Multi-tenancy & safety

- Every document carries a `userId`; every read is scoped to the owner, so
  tenants are isolated.
- Bearer session tokens are validated on every request; only a hash of the token
  is stored, with a hard expiry.
- GitHub access is GET-only and BUILD artifacts stay in the owner's Firestore
  workspace — nothing is applied to any external repo.

## Where to go next

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Integration contract (frozen, v2): [`docs/CONTRACT.md`](docs/CONTRACT.md)
- HTTP API: [`docs/API.md`](docs/API.md)
- Current state & gaps: [`ROADMAP.md`](ROADMAP.md), [`TECH_DEBT.md`](TECH_DEBT.md),
  [`SECURITY_REPORT.md`](SECURITY_REPORT.md), [`PERFORMANCE_REPORT.md`](PERFORMANCE_REPORT.md)
