# Architecture Decision Records (ADR)

Frozen architectural decisions for GHOST Agent Builder. Each ADR records the
**context**, the **decision**, its **consequences**, and the **impact on specific
files**. ADRs are owned by the **Architect**; they constrain Backend/Frontend/QA.

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](./ADR-0001-vector-search.md) | Vector search: Firestore Vector Search vs external vector DB | Accepted |
| [ADR-0002](./ADR-0002-async-ingest.md) | Asynchronous GitHub ingest via Cloud Tasks | Accepted |
| [ADR-0003](./ADR-0003-distributed-rate-limit.md) | Distributed rate limiting (Firestore) vs in-memory | Accepted |
| [ADR-0004](./ADR-0004-dashboard-counters.md) | Dashboard counters vs `count()` ×8 | Accepted |
| [ADR-0005](./ADR-0005-agent-logs-ttl.md) | TTL policy for `agent_logs` | Accepted |
| [ADR-0006](./ADR-0006-firestore-backups.md) | Firestore backups & export | Accepted |
| [ADR-0007](./ADR-0007-ios-firebase-client.md) | Native iOS client with Firebase app registration | Accepted |

See also [`../CONTRACT.md`](../CONTRACT.md) for the frozen integration contract (§1).
