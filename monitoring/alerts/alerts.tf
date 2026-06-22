# Terraform equivalents of the four api AlertPolicy JSON files in this directory.
# The JSON files remain the source of truth for `gcloud ... policies create
# --policy-from-file=`; this module is for teams that manage monitoring as IaC.
# Keep both in sync when tuning thresholds.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project hosting the `api` Cloud Function (Cloud Run service)."
}

variable "notification_channel_ids" {
  type        = list(string)
  description = "Notification channel IDs (e.g. projects/<p>/notificationChannels/<id>) to attach to every policy."
  default     = []
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name backing the Cloud Functions v2 `api` function."
  default     = "api"
}

# Tunable thresholds, surfaced as variables for easy override.
variable "error_rate_threshold" {
  type        = number
  description = "5xx ratio threshold (0.05 = 5%)."
  default     = 0.05
}

variable "p95_latency_threshold_ms" {
  type        = number
  description = "p95 request latency threshold in milliseconds."
  default     = 2000
}

# --- OOM (log-based) -------------------------------------------------------
resource "google_monitoring_alert_policy" "api_oom" {
  project      = var.project_id
  display_name = "api — OOM / memory-limit exceeded"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "OOM log signatures on Cloud Run service api"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${var.service_name}\" severity>=WARNING (textPayload=~\"Memory limit of .* exceeded\" OR textPayload=~\"Reached heap limit\" OR textPayload=~\"JavaScript heap out of memory\" OR textPayload=~\"SIGABRT\" OR textPayload=~\"signal: killed\" OR jsonPayload.event=\"oom\")"
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }

  notification_channels = var.notification_channel_ids

  documentation {
    mime_type = "text/markdown"
    subject   = "[CRITICAL] api OOM / memory-limit exceeded"
    content   = "Severity CRITICAL. OOM signature on the api Cloud Run service. Runbook: https://runbooks.internal/${var.project_id}/api-oom"
  }
}

# --- Elevated 5xx error rate (metric ratio) --------------------------------
resource "google_monitoring_alert_policy" "api_error_rate" {
  project      = var.project_id
  display_name = "api — elevated 5xx error rate (>5% for 5m)"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "5xx ratio of Cloud Run request_count > threshold"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${var.service_name}\" metric.type=\"run.googleapis.com/request_count\" metric.labels.response_code_class=\"5xx\""
      denominator_filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${var.service_name}\" metric.type=\"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = var.error_rate_threshold
      duration           = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }

      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  notification_channels = var.notification_channel_ids

  documentation {
    mime_type = "text/markdown"
    subject   = "[ERROR] api 5xx error rate elevated"
    content   = "Severity ERROR. 5xx ratio exceeded threshold on api. Runbook: https://runbooks.internal/${var.project_id}/api-error-rate"
  }
}

# --- p95 latency (metric) --------------------------------------------------
resource "google_monitoring_alert_policy" "api_p95_latency" {
  project      = var.project_id
  display_name = "api — p95 request latency > 2s for 10m"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Cloud Run request_latencies p95 > threshold"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${var.service_name}\" metric.type=\"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.p95_latency_threshold_ms
      duration        = "600s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.label.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  notification_channels = var.notification_channel_ids

  documentation {
    mime_type = "text/markdown"
    subject   = "[WARNING] api p95 latency elevated"
    content   = "Severity WARNING. p95 latency above threshold on api. Once Agent I OTel latency metric is deployed, switch the filter to workload.googleapis.com/http.server.request.duration. Runbook: https://runbooks.internal/${var.project_id}/api-latency"
  }
}

# --- Vector-search failures (log-based) ------------------------------------
resource "google_monitoring_alert_policy" "api_vector_search_failures" {
  project      = var.project_id
  display_name = "api — Firestore vector-search failures (in-memory fallback)"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "vector_findnearest_fallback_inmemory log event observed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${var.service_name}\" jsonPayload.event=\"vector_findnearest_fallback_inmemory\""
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "600s"
    }
    auto_close = "1800s"
  }

  notification_channels = var.notification_channel_ids

  documentation {
    mime_type = "text/markdown"
    subject   = "[WARNING] api vector search falling back to in-memory"
    content   = "Severity WARNING. Firestore findNearest fell back to in-memory search on api. Once Agent I deploys the fallback counter, prefer a rate-based condition on workload.googleapis.com/vector.search.fallback.count. Runbook: https://runbooks.internal/${var.project_id}/api-vector-search"
  }
}
