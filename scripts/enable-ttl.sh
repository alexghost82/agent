#!/usr/bin/env bash
# Enable Firestore TTL policies (CONTRACT / ADR-0005).
#
# The app writes an `expireAt` Timestamp on ephemeral collections; a TTL policy
# makes Firestore reap them automatically. Run once per project (idempotent).
#
# Usage: PROJECT_ID=my-project ./scripts/enable-ttl.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [ -z "${PROJECT_ID}" ]; then
  echo "Set PROJECT_ID (or gcloud config set project ...)" >&2
  exit 1
fi

echo "Enabling TTL on agent_logs.expireAt for ${PROJECT_ID}"
gcloud firestore fields ttls update expireAt \
  --collection-group=agent_logs --enable-ttl --project="${PROJECT_ID}" --quiet

echo "Enabling TTL on rate_limits.expireAt for ${PROJECT_ID}"
gcloud firestore fields ttls update expireAt \
  --collection-group=rate_limits --enable-ttl --project="${PROJECT_ID}" --quiet

echo "Done. Verify in console: Firestore > TTL."
