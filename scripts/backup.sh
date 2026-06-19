#!/usr/bin/env bash
# Firestore backup / export to GCS (CONTRACT / ADR-0006).
#
# One-off export:   PROJECT_ID=p GCS_BUCKET=gs://p-backups ./scripts/backup.sh
# Scheduled backups (recommended) use the managed backup schedule below.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
GCS_BUCKET="${GCS_BUCKET:-}"
if [ -z "${PROJECT_ID}" ] || [ -z "${GCS_BUCKET}" ]; then
  echo "Set PROJECT_ID and GCS_BUCKET (gs://...)" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
echo "Exporting Firestore (${PROJECT_ID}) -> ${GCS_BUCKET}/${STAMP}"
gcloud firestore export "${GCS_BUCKET}/${STAMP}" --project="${PROJECT_ID}"

cat <<'EOF'

To enable DAILY managed backups with 7-day retention instead of manual exports:

  gcloud firestore backups schedules create \
    --database='(default)' \
    --recurrence=daily \
    --retention=7d

EOF
echo "Done."
