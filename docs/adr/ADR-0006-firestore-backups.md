# ADR-0006 — Firestore backups & export

- **Status:** Implemented
- **Owner:** Architect
- **Affects:** operational (GCP project config), `infra/firestore-backups/` (IaC),
  `docs/RUNBOOK.md`; no application source changes
- **Implementation:** `infra/firestore-backups/` (Terraform) — managed backup
  schedules + scheduled GCS export. See that module's README for apply/restore.

## Context

GHOST stores all durable state in Firestore (`users`, `topics`, `sources`,
`knowledge_chunks`, `agent_skills`, `projects`, `project_decisions`,
`generated_plans`, `agent_logs`). There was **no backup or disaster-recovery
plan**. Risks: accidental mass delete (e.g. a faulty re-ingest or migration),
corrupting writes, or the need to recover a single tenant's data. `agent_logs` also
has a destructive TTL (ADR-0005) that can erase audit history.

## Decision

Adopt a **two-layer** backup strategy, now codified as Terraform in
`infra/firestore-backups/` so it is reproducible and reviewable:

1. **Managed backup schedules (PRIMARY)** —
   `google_firestore_backup_schedule`: a **daily** backup with **7-day**
   retention and a **weekly** backup with **14-week** retention (14 weeks is the
   Firestore maximum). These are transactionally-consistent, point-in-time, and
   give the fastest whole-database restore after operational mistakes. No bucket
   or export job is involved.
2. **Scheduled export to GCS (PORTABLE / DR)** — Cloud Scheduler triggers the
   Firestore `:exportDocuments` API daily, writing to a **versioned, locked-down
   GCS bucket** with a lifecycle/retention rule (default **30 days**). Exports are
   portable: they can be imported into *any* project (cross-project DR, scratch
   restores, per-tenant recovery) and serve as the substrate for compliance
   retention of `agent_logs` beyond its TTL.

Both layers are toggleable (`enable_managed_backups`, `enable_gcs_export`) but
**both are enabled by default**. Restores are validated by periodically restoring
into a **non-production** project (restore drill).

We **reject** building a custom export pipeline (per-collection reads → JSON)
because native backups/exports are transactional, consistent, and cheaper to
operate, and they respect the deny-all rules model (server-side only).

## RPO / RTO targets

| Scenario | Mechanism | RPO (data loss window) | RTO (time to recover) |
| --- | --- | --- | --- |
| Operational mistake (bad migration / mass delete), recent | Managed daily backup | ≤ 24h | minutes–1h (restore to new DB, then cut over) |
| Older regression within retention | Managed weekly backup (≤ 14w) | ≤ 7 days | minutes–1h |
| Project/region loss, or need a portable copy | GCS export import into another project | ≤ 24h | 1–4h (import + validate + cut over) |
| Long-term / compliance (`agent_logs` past TTL) | GCS export object in bucket | per export cadence | retrieval-time only |

Targets assume the live database is never restored **in place** — Firestore
restores always create a *new* database that you then promote, so RTO includes a
cut-over step (re-point Functions config / DNS / clients).

## Retention rationale

- **Daily 7d:** covers the common "we noticed within a week" operational error
  while keeping managed-backup storage small.
- **Weekly 14w:** the Firestore maximum; protects against slow-burn corruption or
  regressions discovered late, without paying for daily granularity that far back.
- **GCS export 30d (configurable):** portable snapshots for DR and cross-project
  recovery; bump `export_retention_days` for longer compliance windows since
  managed backups are capped at 14 weeks.

## Restore procedure

**From a managed backup** (fastest; whole database):

```bash
gcloud firestore backups list --location <LOC> --project <PROJECT_ID>
gcloud firestore databases restore \
  --source-backup=projects/<PROJECT_ID>/locations/<LOC>/backups/<BACKUP_ID> \
  --destination-database='restore-test' \
  --project <PROJECT_ID>
# validate, then promote: re-point app/Functions to the restored database.
```

**From a GCS export** (portable; DR / cross-project / per-tenant):

```bash
gcloud firestore import gs://<PROJECT_ID>-firestore-exports/<EXPORT_FOLDER> \
  --project <SCRATCH_OR_TARGET_PROJECT_ID>
```

Per-document/per-tenant recovery: import the export into a **scratch** project,
read out the needed documents, and copy them back into production. Full operator
steps live in `infra/firestore-backups/README.md` and `docs/RUNBOOK.md`.

## Cost notes

- **Managed backups:** billed on stored backup bytes (GiB-month). Cost scales
  with DB size × number of retained backups (7 daily + 14 weekly here). No
  egress/compute cost to take them.
- **GCS exports:** export operations are billed per document read at export time;
  stored export bytes are billed at GCS standard-storage rates and pruned by the
  lifecycle rule. Daily full exports of a large DB are the main cost lever —
  reduce frequency or scope (`export_collection_ids`) if needed.
- **Cloud Scheduler:** negligible (free tier covers a daily job).

## Consequences

- **Positive:** recoverable from accidental deletes/corruption; tenant or full
  restore possible; portable snapshots decouple retention from TTL; the whole
  strategy is now versioned IaC and peer-reviewable.
- **Negative:** storage cost for backups/exports; restore granularity is
  database-level (per-document restore requires importing into a scratch project
  and copying out); requires IAM (`datastore.importExportAdmin`) and a backup GCS
  bucket; someone must own the **restore drill** cadence.
- **Security:** backup/export buckets contain encrypted-at-rest user API-key
  envelopes and scrypt password hashes — the bucket enforces uniform access +
  public-access-prevention and is writable only by the dedicated exporter SA
  (`roles/storage.objectAdmin` scoped to the bucket). Never expose publicly.

## Impact on files

- `infra/firestore-backups/` — **new** Terraform module implementing both layers
  (this ADR's implementation).
- `docs/RUNBOOK.md` — documents the export command and backup/restore operations
  (done; §9) and now points at the IaC module.
- No application source changes. The module is applied at the **GCP project**
  level, outside the application runtime.

## Resolved questions

- GCS export bucket: defaults to `"${project_id}-firestore-exports"`, colocated
  with the Firestore location (`nam5`); override via `export_bucket_name`.
- Retention windows: **daily 7d / weekly 14w** (managed) + **30d** (GCS export),
  all variable-driven.
