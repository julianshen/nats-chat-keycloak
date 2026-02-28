# Observability Enhancements v2 Design

**Date:** 2026-02-28
**Scope:** Approach B — Fix critical gaps, add self-monitoring, harden infrastructure, close instrumentation gaps, add missing dashboards
**Effort:** 3-5 days

## Goals

- Fix broken alerts and make alerting actionable via Grafana Alerting
- Harden OTel Collector and observability stack (health checks, resource limits, pinned images)
- Add self-monitoring for the observability stack itself (meta-observability)
- Reduce trace storage with tail sampling while keeping all error/slow traces
- Pre-compute expensive dashboard queries via recording rules
- Close instrumentation gaps (KB metrics, browser span attributes, whiteboard OTel, translation labels)
- Add infrastructure health + per-service dashboards for uncovered services

## Section 1: Fix Critical Alert & Monitoring Gaps

### ServiceDown alert replacement
Replace broken `up == 0` rule (Prometheus has no scrape configs, `up` metric never exists) with span-metrics-based detection per service:
```
absent(increase(traces_spanmetrics_calls_total{service_name="X"}[5m])) == 1
```
One sub-rule per service: auth, fanout, room, presence, persist-worker, history, user-search, translation, sticker, app-registry, poll, kb.

### PersistWorkerErrors threshold
Change from `> 0` to `> 5` over 5 minutes to avoid alert fatigue on transient DB blips.

### Explicit Prometheus retention
Add `--storage.tsdb.retention.time=30d` CLI flag. Strategy: Prometheus 30d (metrics are small), Tempo 7d (traces are large), Loki 7d (logs are medium).

### Grafana Alerting
Migrate all Prometheus alert rules to Grafana provisioned alert rules in `grafana/provisioning/alerting/`. Add default contact point (Grafana UI notifications, extensible to Slack/webhook). Remove `prometheus/alert-rules.yaml` and its volume mount. Remove `rule_files` from `prometheus/prometheus.yaml`.

## Section 2: OTel Collector Hardening & Self-Monitoring

### Health checks & resource limits (Docker Compose)
| Service | Health Check | Memory Limit |
|---------|-------------|--------------|
| otel-collector | `:13133/` (health_check extension) | 512M |
| tempo | `:3200/ready` | 1G |
| prometheus | `:9090/-/healthy` | 1G |
| loki | `:3100/ready` | 1G |
| grafana | `:3000/api/health` | 512M |

### OTel Collector extensions
Add `health_check` (port 13133) and `zpages` (port 55679) extensions. Enable built-in Prometheus metrics exporter on `:8888`.

### Prometheus scrape configs
Add scrape jobs for observability stack self-monitoring:
- `otel-collector:8888` — pipeline metrics (spans received/exported/dropped)
- `tempo:3200/metrics` — compaction, WAL size, query latency
- `loki:3100/metrics` — ingestion rate, dropped logs
- `prometheus:9090/metrics` — TSDB stats, rule evaluation

### Pin image tags
Replace all `:latest` with specific pinned versions.

### K8s config sync
- Update K8s OTel Collector ConfigMap to match Docker Compose (memory_limiter, resource processor, HTTP receiver on 4318)
- Add OTEL env vars to kb-service K8s deployment

## Section 3: Tail Sampling & Recording Rules

### Tail sampling processor (OTel Collector)
Add `tail_sampling` processor in traces pipeline:
- **100%**: Traces with error spans (`status_code != STATUS_CODE_OK`)
- **100%**: Traces with latency > 500ms
- **100%**: Traces from auth-service (security-relevant)
- **10%**: Everything else (probabilistic)

Only affects traces pipeline. Metrics and logs unaffected.

### Prometheus recording rules
Pre-compute expensive histogram quantiles:
```yaml
groups:
  - name: service_metrics
    interval: 30s
    rules:
      - record: service:request_rate:5m
        expr: sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))
      - record: service:error_rate:5m
        expr: sum by (service_name) (rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))
      - record: service:p50_latency:5m
        expr: histogram_quantile(0.50, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))
      - record: service:p95_latency:5m
        expr: histogram_quantile(0.95, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))
      - record: service:p99_latency:5m
        expr: histogram_quantile(0.99, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))
```

Update dashboard panels to query recording rules instead of raw metrics.

## Section 4: Service Instrumentation Gaps

### KB service metrics (Java)
Add to `NatsHandler.java`:
- `kb_requests_total` (counter, attribute: action)
- `kb_request_duration_seconds` (histogram, attribute: action)
- `kb_errors_total` (counter, attribute: action)

### Browser span attributes
Update `web/src/utils/tracing.ts` — add optional attributes parameter:
```typescript
startActionSpan('send_message', { 'chat.room': room, 'chat.user': username, 'chat.action': 'send' })
```
Update all call sites in ChatRoom.tsx, ThreadPanel.tsx, MessageProvider.tsx to pass room/user context.

### Whiteboard service OTel
- Add `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_SERVICE_NAME` to Docker Compose and K8s
- Add `@opentelemetry/sdk-node` auto-instrumentation (single init file — picks up HTTP automatically)

### Translation service metric attributes
Add `target_lang` label to `translate_requests_total` and `translate_duration_seconds`.

### Loki security
Change from `user: "0"` (root) to `user: "10001"` in Docker Compose and K8s.

## Section 5: Dashboards & Infrastructure Visibility

### New dashboards

**"NATS Chat - Infrastructure Health"** (`nats-chat-infra.json`):
- OTel Collector: spans received/exported/dropped, exporter latency, memory
- Tempo: compaction, WAL size, query latency, disk
- Loki: ingestion rate vs limit, dropped logs, query latency
- Prometheus: TSDB size, rule evaluation duration

**"NATS Chat - Translation Service"** (`nats-chat-translation.json`):
- Request rate by target_lang, duration percentiles, Ollama health
- Error rate, in-flight translations, traces + logs

**"NATS Chat - Sticker & Search"** (`nats-chat-sticker-search.json`):
- Sticker requests/sec, latency, errors
- User search requests/sec, latency, Keycloak API errors
- Traces + logs

### Dashboard improvements
- Add `$service` template variable to overview dashboard
- Update all panels to use recording rules
- Add alert rule annotations linking to relevant panels

## Out of Scope
- PostgreSQL dashboard (otelsql spans visible in Tempo)
- NATS JetStream dashboard (requires separate exporter)
- Read-receipt service dashboard (minor service)
- Multi-zone HA / S3 storage backends
- SLO-based error budget alerting
- Anomaly detection / baseline learning
