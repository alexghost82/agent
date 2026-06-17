# Security notes

- Do not expose `OPENAI_API_KEY` or user GitHub tokens to the browser. All model
  calls and GitHub access stay inside Firebase Functions.
- Every API endpoint (except `/health` and `/login`) requires a Bearer session token.
- All Firestore documents are scoped by `userId`; users cannot see each other's data.
- Direct client access to Firestore is denied; access goes through the Admin SDK in Functions.
- Passwords are hashed with `scrypt` and a per-user salt. Seed users come from the
  `SEED_USERS` env var, never from source code.
- `/learn` is SSRF-guarded: only public http(s) URLs that do not resolve to private,
  loopback or link-local addresses are fetched.
- GitHub ingestion is read-only (GET requests only). The agent never writes to a repo.
- Heavy endpoints are rate-limited (best-effort, per user).
- Restrict CORS in production via `ALLOWED_ORIGINS`.
- CI runs a secret scan; keep real secrets out of the repository.
