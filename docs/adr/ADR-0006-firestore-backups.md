# ADR-0006 — Firestore backups & export

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** operational (GCP project config), `docs/RUNBOOK.md`; no application source changes

## Context

GHOST stores all durable state in Firestore (`users`, `topics`, `sources`,
`knowledge_chunks`, `agent_skills`, `projects`, `project_decisions`,
`generated_plans`, `agent_logs`). There is currently **no backup or disaster-recovery
plan**. Risks: accidental mass delete (e.g. a faulty re-ingest or migration),
corrupting writes, or the need to recover a single tenant's data. `agent_logs` also
has a destructive TTL (ADR-0005) that can erase audit history.

## Decision

Adopt a **two-layer** backup strategy using Firestore-native tooling:

1. **Scheduled backups** (point-in-time, Firestore "backup schedules"): a daily
   backup with **7-day** retention and a weekly backup with **~5-week** retention,
   for fast restore of the whole database after operational mistakes.
2. **Managed export to GCS** (`gcloud firestore export gs://<bucket>`) on a periodic
   schedule for **portable, long-lived** snapshots (and the substrate for any
   compliance retention of `agent_logs` before TTL deletes it).

Restores are validated by periodically restoring into a **non-production** project.

We **reject** building a custom export pipeline (per-collection reads → JSON) because
native backups/exports are transactional, consistent, and cheaper to operate, and
they respect the deny-all rules model (server-side only).

## Consequences

- **Positive:** recoverable from accidental deletes/corruption; tenant or full
  restore possible; long-term snapshots decouple retention from TTL.
- **Negative:** storage cost for backups/exports; restore granularity is
  database-level (per-document restore requires importing into a scratch project and
  copying out); requires IAM (`datastore.importExportAdmin`) and a backup GCS bucket;
  someone must own the **restore drill** cadence.
- **Security:** backup/export buckets contain encrypted-at-rest user API-key
  envelopes and scrypt password hashes — lock bucket IAM down to operators only;
  never expose publicly.

## Impact on files

- `docs/RUNBOOK.md` — documents the export command and backup/restore operations
  (done; §9).
- No application source changes. Backup schedules and export jobs are configured at
  the **GCP project** level (Firebase console / `gcloud`), outside the repository.
- **Open question:** confirm the GCS backup bucket name/region and the retention
  windows (daily 7d / weekly 5w proposed) with the project owner.
