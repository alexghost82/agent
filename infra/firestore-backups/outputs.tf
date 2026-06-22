output "managed_daily_backup_schedule" {
  description = "Resource name of the daily managed backup schedule, if enabled."
  value       = var.enable_managed_backups ? google_firestore_backup_schedule.daily[0].name : null
}

output "managed_weekly_backup_schedule" {
  description = "Resource name of the weekly managed backup schedule, if enabled."
  value       = var.enable_managed_backups && var.enable_weekly_backup ? google_firestore_backup_schedule.weekly[0].name : null
}

output "export_bucket" {
  description = "Name of the GCS export bucket, if the export pipeline is enabled."
  value       = var.enable_gcs_export ? google_storage_bucket.exports[0].name : null
}

output "exporter_service_account" {
  description = "Email of the least-privilege export service account, if enabled."
  value       = var.enable_gcs_export ? google_service_account.exporter[0].email : null
}

output "export_scheduler_job" {
  description = "Cloud Scheduler job id for the GCS export, if enabled."
  value       = var.enable_gcs_export ? google_cloud_scheduler_job.firestore_export[0].id : null
}
