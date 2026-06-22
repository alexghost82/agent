# Architecture Decision Records (ADR)

Frozen architectural decisions for GHOST Agent Builder. Each ADR records the
**context**, the **decision**, its **consequences**, and the **impact on specific
files**. ADRs are owned by the **Architect**; they constrain Backend/Frontend/QA.

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](./ADR-0001-vector-search.md) | Vector search: Firestore Vector Search vs external vector DB | Accepted — Implemented |
| [ADR-0002](./ADR-0002-async-ingest.md) | Asynchronous GitHub ingest via Cloud Tasks | Accepted |
| [ADR-0003](./ADR-0003-distributed-rate-limit.md) | Distributed rate limiting (Firestore) vs in-memory | Accepted |
| [ADR-0004](./ADR-0004-dashboard-counters.md) | Dashboard counters vs `count()` ×8 | Accepted |
| [ADR-0005](./ADR-0005-agent-logs-ttl.md) | TTL policy for `agent_logs` | Accepted |
| [ADR-0006](./ADR-0006-firestore-backups.md) | Firestore backups & export | Implemented |
| [ADR-0007](./ADR-0007-ios-firebase-client.md) | Native iOS client with Firebase app registration | Accepted |
| [ADR-0008](./ADR-0008-embedding-dimension.md) | Embedding dimension: one canonical dimension via a normalization layer | Accepted — Implemented |

> **2026-06-22 status sync (4-wave hardening orchestration):** ADR-0001 implemented
> on `feature/vector-backend` (Firestore Vector Search is the default backend);
> ADR-0006 implemented on `feature/firestore-backups` (Terraform-managed backups +
> scheduled export); ADR-0008 added on `feature/embedding-dimension` (canonical
> embedding dimension). The `ADR-0008` file lands with that branch — see the
> [integration plan](../notes/integration-plan.md).

See also [`../CONTRACT.md`](../CONTRACT.md) for the frozen integration contract (§1).
