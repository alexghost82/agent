# ---------------------------------------------------------------------------
# ALTERNATIVE / COMPLEMENTARY STRATEGY: scheduled export to GCS.
#
# Cloud Scheduler -> Firestore export API (:exportDocuments) -> versioned GCS
# bucket with lifecycle/retention. Produces portable, long-lived, point-in-time
# snapshots that can be imported into ANY project (DR, scratch restores,
# compliance retention of agent_logs before TTL deletes it).
# ---------------------------------------------------------------------------

locals {
  export_bucket_name = var.export_bucket_name != "" ? var.export_bucket_name : "${var.project_id}-firestore-exports"
}

# --- Versioned, locked-down export bucket -------------------------------------
resource "google_storage_bucket" "exports" {
  count = var.enable_gcs_export ? 1 : 0

  project  = var.project_id
  name     = local.export_bucket_name
  location = var.firestore_location
  labels   = var.labels

  # Backups contain encrypted user API-key envelopes and scrypt password hashes
  # (ADR-0006). Never expose publicly; lock to operators/SA via IAM only.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Keep prior export folders recoverable if an export is overwritten.
  versioning {
    enabled = true
  }

  # Retention: delete live export objects after N days, and prune old
  # non-current versions shortly after they are superseded.
  lifecycle_rule {
    condition {
      age = var.export_retention_days
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 3
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

# --- Dedicated, least-privilege service account for exports -------------------
resource "google_service_account" "exporter" {
  count = var.enable_gcs_export ? 1 : 0

  project      = var.project_id
  account_id   = "firestore-exporter"
  display_name = "Firestore scheduled export (ADR-0006)"
  description  = "Runs Firestore :exportDocuments on a schedule and writes to the export bucket only."
}

# Project-level: ability to start managed import/export operations.
# This is the minimal predefined role that grants exportDocuments.
resource "google_project_iam_member" "exporter_import_export" {
  count = var.enable_gcs_export ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.importExportAdmin"
  member  = "serviceAccount:${google_service_account.exporter[0].email}"
}

# Bucket-scoped only: write/manage export objects in THIS bucket, nowhere else.
resource "google_storage_bucket_iam_member" "exporter_bucket_writer" {
  count = var.enable_gcs_export ? 1 : 0

  bucket = google_storage_bucket.exports[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.exporter[0].email}"
}

# --- Scheduled trigger --------------------------------------------------------
resource "google_cloud_scheduler_job" "firestore_export" {
  count = var.enable_gcs_export ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "firestore-gcs-export"
  description = "Daily Firestore export to ${local.export_bucket_name} (ADR-0006)."
  schedule    = var.export_schedule_cron
  time_zone   = var.export_schedule_timezone

  attempt_deadline = "320s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://firestore.googleapis.com/v1/projects/${var.project_id}/databases/${var.database_id}:exportDocuments"

    headers = {
      "Content-Type" = "application/json"
    }

    # outputUriPrefix is timestamp-free here; Firestore writes a unique,
    # operation-scoped folder under it, so successive exports never clobber.
    # Provide collectionIds only when a subset is configured.
    body = base64encode(jsonencode(merge(
      { outputUriPrefix = "gs://${google_storage_bucket.exports[0].name}" },
      length(var.export_collection_ids) > 0 ? { collectionIds = var.export_collection_ids } : {}
    )))

    oauth_token {
      service_account_email = google_service_account.exporter[0].email
      scope                 = "https://www.googleapis.com/auth/datastore"
    }
  }

  depends_on = [
    google_project_iam_member.exporter_import_export,
    google_storage_bucket_iam_member.exporter_bucket_writer,
  ]
}
