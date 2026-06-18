# ADR-0003 — Distributed rate limiting (Firestore) vs in-memory

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** `functions/src/ratelimit.ts`, `functions/src/routes/public.ts`, `firestore.rules`

## Context

`ratelimit.ts` keeps counters in a per-instance in-memory `Map` (`ratelimit.ts:6`).
Its own comment is honest: "Cloud Functions run multiple instances, so this is a
soft guard … not a hard quota." With `minInstances`/autoscaling (Contract §7),
limits are effectively multiplied by the instance count, and the most
abuse-sensitive endpoint — `POST /login` (`routes/public.ts`, unauthenticated,
runs `ensureSeedUsers()` per call) — is not reliably protected.

## Decision

Adopt a **distributed, Firestore-backed fixed-window rate limiter** as the source
of truth for security-sensitive limits (login and other unauthenticated/abuse-prone
routes). Implementation: a `rate_limits/{bucketKey}` document updated in a
**transaction** (or `FieldValue.increment` within a transaction) keyed by
`{name}:{userId|ip}:{window}`, with the window encoded in the doc id so old windows
self-expire (see ADR-0005 for TTL).

We **reject Redis/Memorystore** for now: it adds a VPC connector, a managed
instance, and another failure domain for a small user base. Firestore reuses our
existing datastore, IAM, and isolation model. Revisit Redis only if limiter write
QPS becomes a Firestore hot-spot.

The in-memory limiter is kept as a **fast L1 pre-check** in front of the Firestore
L2 check (cheap rejection of obvious floods without a Firestore round-trip).

## Consequences

- **Positive:** limits hold across instances; `login` gets a real quota; no new
  infrastructure.
- **Negative:** each limited request costs a Firestore read+write; fixed-window has
  boundary bursts (acceptable for abuse control); hot keys could contend — mitigate
  with per-key sharding only if needed.
- **Rules impact:** `rate_limits` is written only by the Admin SDK; `firestore.rules`
  deny-all already covers it (no client access). No rule change required.

## Impact on files

- `functions/src/ratelimit.ts` — add the Firestore-backed limiter (transactional
  counter), keep the in-memory pre-check (Backend).
- `functions/src/routes/public.ts` — apply the distributed limiter to `/login`
  (Backend).
- `firestore.indexes.json` — none required (lookups are by document id).
