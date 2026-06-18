# ADR-0005 — TTL policy for `agent_logs`

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** `functions/src/util.ts` (`logEvent`), `firestore.indexes.json` (field override / TTL), `functions/src/routes/dashboard.ts`

## Context

`agent_logs` is an append-only, per-user audit trail written via `logEvent`
(`util.ts`) on most mutating actions. It grows without bound: nothing deletes old
entries, the dashboard only ever reads the most recent ~10–50 (`dashboard.ts:28-32`),
and unbounded growth inflates storage cost and the `agent_logs (userId + createdAt)`
index (Contract §5).

## Decision

Apply a **Firestore TTL policy** on `agent_logs` using a dedicated
**`expireAt: Timestamp`** field. `logEvent` stamps `expireAt = now + RETENTION`
(default **90 days**) on every write. Firestore's TTL service deletes expired
documents automatically in the background (best-effort, typically within ~24h of
expiry). Retention is a single tunable constant.

We **reject** scheduled-function cleanup (a cron that batch-deletes) because native
TTL is cheaper (no scheduled reads/deletes we pay for), simpler, and has no
maintenance window. We **reject** "no retention" because it makes cost and index
size grow forever for data that is only ever read at the head.

## Consequences

- **Positive:** bounded storage and index size; zero operational cron; audit window
  is explicit and configurable.
- **Negative:** logs older than the retention window are **permanently lost** — if
  long-term audit/compliance retention is ever required, export to cold storage
  (BigQuery / GCS) **before** TTL deletes them (ties into ADR-0006). TTL deletion is
  not instantaneous, so do not rely on it for security-sensitive immediate removal.
- TTL deletes count as normal deletes for billing but are spread out and
  unmetered against function invocations.

## Impact on files

- `functions/src/util.ts` — `logEvent` adds `expireAt` to each `agent_logs` write
  (Backend).
- `firestore.indexes.json` — Architect adds the **TTL field override** for
  `agent_logs.expireAt` (the TTL policy is enabled per field; coordinate exact
  `fieldOverrides`/console enablement).
- **Open question:** confirm the retention window (90 days proposed) and whether any
  compliance requirement forces pre-deletion export (ADR-0006).
