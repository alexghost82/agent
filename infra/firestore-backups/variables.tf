variable "project_id" {
  description = "GCP project ID that owns the Firestore database (placeholder; do not hardcode real values)."
  type        = string
}

variable "region" {
  description = "Default region for regional resources (Cloud Scheduler, etc.). Keep close to the Firestore location."
  type        = string
  default     = "us-central1"
}

variable "database_id" {
  description = "Firestore database ID. The production GHOST database is the default one."
  type        = string
  default     = "(default)"
}

variable "firestore_location" {
  description = "Firestore database location/multi-region (e.g. nam5, eur3, us-central1). Used to colocate the export bucket."
  type        = string
  default     = "nam5"
}

# ---------------------------------------------------------------------------
# Managed (Firestore-native) backup schedules
# ---------------------------------------------------------------------------

variable "enable_managed_backups" {
  description = "Toggle the Firestore-native scheduled backups (primary strategy)."
  type        = bool
  default     = true
}

variable "daily_backup_retention" {
  description = "Retention for the daily managed backup, as a duration string in seconds (Terraform/Google API format). 7 days = 604800s. Allowed range: up to 14 weeks."
  type        = string
  default     = "604800s" # 7 days
}

variable "enable_weekly_backup" {
  description = "Also create a weekly managed backup with longer retention."
  type        = bool
  default     = true
}

variable "weekly_backup_retention" {
  description = "Retention for the weekly managed backup, in seconds. 14 weeks = 8467200s (max allowed by Firestore managed backups)."
  type        = string
  default     = "8467200s" # 14 weeks (98 days)
}

variable "weekly_backup_day" {
  description = "Day of week the weekly managed backup runs."
  type        = string
  default     = "SUNDAY"

  validation {
    condition = contains(
      ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
      var.weekly_backup_day
    )
    error_message = "weekly_backup_day must be an upper-case English day name (MONDAY..SUNDAY)."
  }
}

# ---------------------------------------------------------------------------
# Scheduled GCS export (portable point-in-time snapshots)
# ---------------------------------------------------------------------------

variable "enable_gcs_export" {
  description = "Toggle the scheduled Firestore -> GCS export pipeline (Cloud Scheduler + export API)."
  type        = bool
  default     = true
}

variable "export_bucket_name" {
  description = "Globally-unique name for the export bucket. If empty, defaults to '<project_id>-firestore-exports'."
  type        = string
  default     = ""
}

variable "export_schedule_cron" {
  description = "Cron schedule (Cloud Scheduler / unix-cron) for the GCS export job. Default 02:30 daily."
  type        = string
  default     = "30 2 * * *"
}

variable "export_schedule_timezone" {
  description = "IANA time zone for the export schedule."
  type        = string
  default     = "Etc/UTC"
}

variable "export_retention_days" {
  description = "Age (days) after which exported objects are deleted by the bucket lifecycle rule."
  type        = number
  default     = 30
}

variable "export_collection_ids" {
  description = "Optional subset of collections to export. Empty list exports the whole database."
  type        = list(string)
  default     = []
}

variable "labels" {
  description = "Labels applied to created resources for cost attribution."
  type        = map(string)
  default = {
    component = "firestore-backups"
    managed   = "terraform"
  }
}
