# Firestore backups — Infrastructure as Code

Terraform for the GHOST Firestore backup strategy (see
[`docs/adr/ADR-0006-firestore-backups.md`](../../docs/adr/ADR-0006-firestore-backups.md)).

Two layers, both managed here:

| Layer | Resource | Purpose | Default retention |
| --- | --- | --- | --- |
| **Primary** | `google_firestore_backup_schedule` (daily + weekly) | Fast, consistent, whole-database restore after operational mistakes | 7 days (daily), 14 weeks (weekly) |
| **Portable** | Cloud Scheduler → Firestore `:exportDocuments` → versioned GCS bucket | Portable point-in-time snapshots for DR / cross-project restore / long-term compliance | 30 days (bucket lifecycle) |

All values are placeholders driven by variables — **no real project IDs are committed.**

## Files

| File | Contents |
| --- | --- |
| `versions.tf` | Terraform + `hashicorp/google` provider pins. |
| `variables.tf` | All inputs (project, region, retention, toggles). |
| `apis.tf` | Enables required Google APIs (toggle with `manage_apis`). |
| `backup-schedules.tf` | Managed daily/weekly backup schedules (primary). |
| `exports.tf` | Export bucket + lifecycle, least-privilege SA + IAM, scheduler job. |
| `outputs.tf` | Resource names/emails for downstream wiring. |
| `terraform.tfvars.example` | Copy to `terraform.tfvars` and fill in. |

## Prerequisites

- Terraform `>= 1.5`.
- `gcloud` authenticated with rights to manage the project
  (`gcloud auth application-default login`), or a CI service account with
  equivalent permissions.
- Firestore database already provisioned (GHOST uses the `(default)` database in
  location `nam5`).

### Required Google APIs

`apis.tf` enables these for you (set `manage_apis=false` to opt out and enable
them manually):

```bash
gcloud services enable \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  --project <PROJECT_ID>
```

## Apply

```bash
cd infra/firestore-backups
cp terraform.tfvars.example terraform.tfvars   # then edit values

terraform init
terraform fmt -check
terraform validate
terraform plan      # review: 2 backup schedules, 1 bucket, 1 SA, 2 IAM, 1 scheduler job
terraform apply
```

State is stored locally by default. For team use, configure a remote backend
(e.g. a GCS backend block) — intentionally omitted here so the module stays
project-agnostic.

## Permissions created (least privilege)

The export pipeline runs as a dedicated service account `firestore-exporter`:

| Binding | Scope | Why |
| --- | --- | --- |
| `roles/datastore.importExportAdmin` | project | Start `:exportDocuments` operations. |
| `roles/storage.objectAdmin` | **export bucket only** | Write/manage export objects — nowhere else. |

The bucket is `uniform_bucket_level_access = true` and
`public_access_prevention = "enforced"`. Exports contain encrypted user
API-key envelopes and password hashes, so bucket access must stay
operator/SA-only.

## Verify a manual export

Trigger the scheduled job immediately, or call the export API directly:

```bash
# Option A: run the Terraform-created Cloud Scheduler job now
gcloud scheduler jobs run firestore-gcs-export \
  --location <REGION> --project <PROJECT_ID>

# Option B: ad-hoc export via gcloud (same effect as the job)
gcloud firestore export gs://<PROJECT_ID>-firestore-exports \
  --project <PROJECT_ID>

# Confirm a new export folder appeared
gcloud storage ls gs://<PROJECT_ID>-firestore-exports/
```

List managed backups and schedules:

```bash
gcloud firestore backups schedules list --database='(default)' --project <PROJECT_ID>
gcloud firestore backups list --location nam5 --project <PROJECT_ID>
```

## Restore drill (do this periodically into a NON-prod project)

**From a managed backup** (creates a *new* database from the backup):

```bash
gcloud firestore databases restore \
  --source-backup=projects/<PROJECT_ID>/locations/<LOC>/backups/<BACKUP_ID> \
  --destination-database='restore-test' \
  --project <PROJECT_ID>
```

**From a GCS export** (import into a scratch project/database):

```bash
gcloud firestore import gs://<PROJECT_ID>-firestore-exports/<EXPORT_FOLDER> \
  --project <SCRATCH_PROJECT_ID>
```

Validate row counts / spot-check a few documents, then delete the scratch
database. Record the drill outcome in `docs/RUNBOOK.md`.

## Notes

- Managed-backup retention is capped by Firestore at **14 weeks**; for anything
  longer-lived, rely on the GCS exports (adjust `export_retention_days`).
- Restores never overwrite the live database in place — they always create a new
  database, which you then promote/migrate. Plan RTO accordingly.
