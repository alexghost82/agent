# ---------------------------------------------------------------------------
# PRIMARY STRATEGY: Firestore-native managed backup schedules.
#
# These are point-in-time, transactionally-consistent backups managed by
# Firestore itself (no GCS bucket, no export job). They are the fastest path
# to restore the whole database after an operational mistake.
#
# Constraints (Firestore managed backups):
#   - Daily schedule retention: up to 14 weeks.
#   - Weekly schedule retention: up to 14 weeks.
#   - At most one daily and a limited number of weekly schedules per database.
#   - Restores create a NEW database from a backup (see README / ADR-0006).
# ---------------------------------------------------------------------------

resource "google_firestore_backup_schedule" "daily" {
  count = var.enable_managed_backups ? 1 : 0

  project   = var.project_id
  database  = var.database_id
  retention = var.daily_backup_retention

  daily_recurrence {}
}

resource "google_firestore_backup_schedule" "weekly" {
  count = var.enable_managed_backups && var.enable_weekly_backup ? 1 : 0

  project   = var.project_id
  database  = var.database_id
  retention = var.weekly_backup_retention

  weekly_recurrence {
    day = var.weekly_backup_day
  }
}
