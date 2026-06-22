# Monitoring & Alerting — `api` Cloud Function

Alerting for the `api` Cloud Function (Cloud Functions v2 → Cloud Run service `api`,
default region). Four policies are defined as Google Cloud Monitoring `AlertPolicy`
JSON files under [`alerts/`](./alerts), with optional Terraform equivalents in
[`alerts/alerts.tf`](./alerts/alerts.tf).

| Alert | File | Type | Active when | Default severity |
|-------|------|------|-------------|------------------|
| OOM / memory-limit exceeded | `alerts/oom.alert.json` | Log-based | Immediately | CRITICAL |
| Elevated 5xx error rate | `alerts/error-rate.alert.json` | Metric (Cloud Run native) | Immediately | ERROR |
| p95 request latency | `alerts/p95-latency.alert.json` | Metric (Cloud Run native; OTel optional) | Immediately | WARNING |
| Firestore vector-search failures | `alerts/vector-search-failures.alert.json` | Log-based | When Agent A's log event ships | WARNING |

> **Log-based vs metric-based:** the two log-based policies (`oom`, `vector-search-failures`)
> work the moment the matching log lines appear and have **no dependency on Agent I's
> telemetry**. The two metric policies (`error-rate`, `p95-latency`) use Cloud Run's
> **native** `run.googleapis.com/*` metrics, so they also work immediately — but each can
> be upgraded to consume Agent I's OTel metrics once that telemetry is deployed (see below).

## Prerequisites

1. **Project**: replace `${PROJECT_ID}` with your GCP project (or pass `--project`).
2. **Notification channel**: create one and capture its ID for `${NOTIFICATION_CHANNEL_ID}`:

```bash
# List existing channels
gcloud beta monitoring channels list --project="${PROJECT_ID}"

# Or create one (example: email)
gcloud beta monitoring channels create \
  --project="${PROJECT_ID}" \
  --display-name="api oncall" \
  --type=email \
  --channel-labels=email_address=oncall@example.com
```

The channel ID looks like `projects/${PROJECT_ID}/notificationChannels/1234567890`.

## Applying the policies (gcloud)

Each JSON contains `${NOTIFICATION_CHANNEL_ID}` and (in documentation/runbook links)
`${PROJECT_ID}` placeholders. Substitute them before applying — e.g. with `envsubst`:

```bash
export PROJECT_ID="your-project"
export NOTIFICATION_CHANNEL_ID="projects/your-project/notificationChannels/1234567890"

for f in monitoring/alerts/*.alert.json; do
  envsubst < "$f" > "/tmp/$(basename "$f")"
  gcloud alpha monitoring policies create \
    --project="${PROJECT_ID}" \
    --policy-from-file="/tmp/$(basename "$f")"
done
```

Apply a single policy:

```bash
envsubst < monitoring/alerts/oom.alert.json > /tmp/oom.alert.json
gcloud alpha monitoring policies create \
  --project="${PROJECT_ID}" \
  --policy-from-file=/tmp/oom.alert.json
```

Update an existing policy (find its ID with `gcloud alpha monitoring policies list`):

```bash
gcloud alpha monitoring policies update POLICY_ID \
  --project="${PROJECT_ID}" \
  --policy-from-file=/tmp/oom.alert.json
```

### Terraform alternative

```bash
cd monitoring/alerts
terraform init
terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var='notification_channel_ids=["projects/your-project/notificationChannels/1234567890"]'
```

## Thresholds & rationale

All thresholds are labeled `TUNABLE` in each JSON's `documentation.content` and are
exposed as variables in `alerts.tf`.

| Alert | Threshold | Window | Rationale |
|-------|-----------|--------|-----------|
| OOM | any matching log line | rate-limited to 1 notification / 5m | OOM is always actionable; rate limit prevents a crash loop from flooding oncall. |
| Error rate | 5xx / total `> 5%` | 5m (`ALIGN_RATE`, ratio) | Ratio (not raw count) avoids paging on low traffic; 5% over 5m filters single-request blips. |
| p95 latency | `> 2000 ms` | 10m (`ALIGN_PERCENTILE_95`) | 2s p95 is a generous interactive-API ceiling; 10m avoids paging on brief spikes/cold starts. |
| Vector-search failures | any fallback log event | rate-limited to 1 notification / 10m | Fallback means degraded recall/latency; even occasional fallback is worth surfacing, throttled to avoid noise. |

Tune by editing `thresholdValue` / `duration` / `alignmentPeriod` in the JSON (or the
`*_threshold*` variables in Terraform).

## Which Agent-I metric each alert consumes

Agent I (observability, Wave 3) is adding OTel metrics: request latency, vector-search
latency, a counter distinguishing **firestore vs in-memory-fallback**, and a `recordError`
hook. Exact exported metric names/units depend on Agent I's exporter config (OTel→Cloud
Monitoring typically lands custom metrics under the `workload.googleapis.com/` prefix);
confirm names with `gcloud monitoring metrics-descriptors list` after deploy.

| Alert | Today (no dependency) | Agent-I metric upgrade |
|-------|-----------------------|------------------------|
| OOM | Log signatures + (optional) `run.googleapis.com/container/memory/utilizations` | — (OOM stays log/infra based) |
| Error rate | `run.googleapis.com/request_count` (`response_code_class=5xx`) | Optionally Agent I's `recordError` counter for app-level error classification |
| p95 latency | `run.googleapis.com/request_latencies` (ms) | `workload.googleapis.com/http_server_request_ms` (histogram, ms) |
| Vector-search failures | `jsonPayload.event="vector_findnearest_fallback_inmemory"` log | `workload.googleapis.com/vector_search_fallback_total` (counter, label `reason`; rate threshold) |

> **Risk:** the metric-name upgrades above are placeholders until Agent I's telemetry is
> deployed and the descriptors confirmed. The shipped policies deliberately default to
> native Cloud Run metrics and log events so they are functional **without** Agent I.

## Optional companion: OOM via memory utilization

Cloud Monitoring only allows **one** condition in a log-based policy, so the
memory-utilization signal cannot be combined into `oom.alert.json`. Apply this as an
additional metric policy if you want to catch sustained memory pressure *before* the kill:

```json
{
  "displayName": "api — container memory utilization near limit",
  "combiner": "OR",
  "severity": "WARNING",
  "conditions": [
    {
      "displayName": "memory utilization > 90% for 5m",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"api\" metric.type=\"run.googleapis.com/container/memory/utilizations\"",
        "aggregations": [
          { "alignmentPeriod": "60s", "perSeriesAligner": "ALIGN_PERCENTILE_99", "crossSeriesReducer": "REDUCE_MEAN", "groupByFields": ["resource.label.service_name"] }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.9,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": { "autoClose": "1800s" },
  "notificationChannels": ["${NOTIFICATION_CHANNEL_ID}"],
  "documentation": { "mimeType": "text/markdown", "content": "Severity WARNING. api memory utilization > 90%. Precursor to OOM; consider raising the memory limit." }
}
```

## Validation & build

- **JSON parse-check**: all four `*.alert.json` files (and the README snippet) are valid
  JSON — verify with: `for f in monitoring/alerts/*.alert.json; do python3 -m json.tool "$f" >/dev/null && echo "OK $f"; done`.
- **No build/test in this branch**: this branch is **config only** (alert definitions +
  docs). There is intentionally no application build or unit test to run here. Validation
  is limited to JSON parsing (and, optionally, `terraform validate` for `alerts.tf`).
