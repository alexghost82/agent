# Architecture

The canonical architecture document for GHOST Agent Builder 2.0 lives at
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Please read it there to avoid
drift — this file is only a short pointer and summary.

## Summary

- **Frontend:** Next.js static export (`output: "export"`, `app/`) served by
  Firebase Hosting. `/api/**` is rewritten to the `api` Cloud Function.
- **Backend:** one Express app (Node 22) exported as the `api` Gen2 HTTPS
  function (`functions/src/index.ts`), with one router per area under
  `functions/src/routes/*` and shared modules (`auth`, `memory`, `ai`, `crypto`,
  `ratelimit`, `errors`, `ssrf`, `github`, `stats`, `listing`).
- **Storage:** Firestore via the Admin SDK only; client rules are deny-all
  (`firestore.rules`). Composite indexes live in `firestore.indexes.json`.
- **Multi-tenancy:** every document carries `userId`; all reads are owner-scoped.
  Bearer session tokens are validated per request (only the token hash is stored,
  with a hard expiry).
- **AI providers:** pluggable OpenAI / Gemini. Each user can bring their own key
  (encrypted at rest, AES-256-GCM via `KEYS_ENC_SECRET`); the server env key is a
  fallback. Calls fail with `no_api_key` when neither is available.
- **Safety:** GitHub access is GET-only; BUILD artifacts are written only into
  the owner's Firestore workspace and downloaded client-side — never pushed to
  any external repo.

## Related documents

- Frozen integration contract (v2): [`docs/CONTRACT.md`](docs/CONTRACT.md)
- HTTP API: [`docs/API.md`](docs/API.md)
- Architecture findings & report: [`ARCHITECTURE_REPORT.md`](ARCHITECTURE_REPORT.md)
- ADRs: [`docs/adr`](docs/adr)
