# Observability Enhancements v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical alert gaps, harden the observability stack, add tail sampling & recording rules, close service instrumentation gaps, and add missing dashboards.

**Architecture:** Incremental enhancement across 5 phases. Phase 1 fixes broken alerts by migrating to Grafana Alerting. Phase 2 hardens infrastructure (health checks, resource limits, pinned images, self-monitoring scrapes). Phase 3 adds tail sampling and recording rules. Phase 4 closes instrumentation gaps (KB metrics, browser span attributes, whiteboard OTel, translation labels). Phase 5 adds infrastructure health and per-service dashboards.

**Tech Stack:** OTel Collector (contrib), Prometheus, Grafana provisioned alerting, Go/Java/TypeScript/Node.js OTel SDKs

---

## Phase 1: Fix Critical Alert & Monitoring Gaps

### Task 1: Migrate alerts to Grafana Alerting

**Files:**
- Create: `grafana/provisioning/alerting/alerts.yaml`
- Modify: `prometheus/prometheus.yaml`
- Delete content from: `prometheus/alert-rules.yaml` (keep file empty or remove)
- Modify: `docker-compose.yml` (remove alert-rules volume from prometheus)

**Step 1: Create Grafana alerting provisioning directory and rules file**

Create `grafana/provisioning/alerting/alerts.yaml`:

```yaml
apiVersion: 1

groups:
  - orgId: 1
    name: service_health
    folder: NATS Chat Alerts
    interval: 30s
    rules:
      - uid: service-down-auth
        title: "Auth Service Down"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(traces_spanmetrics_calls_total{service_name="auth-service"}[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: lt
                    params: [0.001]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "auth-service has produced no spans in 5 minutes"

      - uid: service-down-fanout
        title: "Fanout Service Down"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(traces_spanmetrics_calls_total{service_name="fanout-service"}[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: lt
                    params: [0.001]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "fanout-service has produced no spans in 5 minutes"

      - uid: service-down-room
        title: "Room Service Down"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(traces_spanmetrics_calls_total{service_name="room-service"}[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: lt
                    params: [0.001]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "room-service has produced no spans in 5 minutes"

      - uid: service-down-presence
        title: "Presence Service Down"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(traces_spanmetrics_calls_total{service_name="presence-service"}[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: lt
                    params: [0.001]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "presence-service has produced no spans in 5 minutes"

      - uid: service-down-persist
        title: "Persist Worker Down"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(traces_spanmetrics_calls_total{service_name="persist-worker"}[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: lt
                    params: [0.001]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "persist-worker has produced no spans in 5 minutes"

      - uid: service-down-history
        title: "History Service Down"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(traces_spanmetrics_calls_total{service_name="history-service"}[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: lt
                    params: [0.001]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "history-service has produced no spans in 5 minutes"

  - orgId: 1
    name: error_rates
    folder: NATS Chat Alerts
    interval: 30s
    rules:
      - uid: high-error-rate
        title: "High Error Rate"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: "sum by (service_name) (rate(traces_spanmetrics_calls_total{status_code=\"STATUS_CODE_ERROR\"}[5m])) / sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))"
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: gt
                    params: [0.05]
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate > 5% for {{ $labels.service_name }}"

      - uid: persist-worker-errors
        title: "Persist Worker Errors"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: increase(messages_persist_errors_total[5m])
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: gt
                    params: [5]
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "persist-worker has >5 persistence errors in last 5 minutes"

      - uid: auth-rejection-spike
        title: "Auth Rejection Spike"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: "sum(rate(auth_requests_total{result=\"rejected\"}[5m])) / sum(rate(auth_requests_total[5m]))"
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: gt
                    params: [0.20]
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Auth rejection rate > 20%"

  - orgId: 1
    name: latency
    folder: NATS Chat Alerts
    interval: 30s
    rules:
      - uid: slow-requests
        title: "Slow Requests"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: "histogram_quantile(0.95, sum by (le, service_name) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))"
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: gt
                    params: [2]
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P95 latency > 2s for {{ $labels.service_name }}"

      - uid: high-fanout-latency
        title: "High Fanout Latency"
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus
            model:
              expr: "histogram_quantile(0.95, sum by (le) (rate(fanout_duration_seconds_bucket[5m])))"
              instant: true
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator:
                    type: gt
                    params: [0.5]
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Fanout P95 latency > 500ms"

contactPoints:
  - orgId: 1
    name: grafana-default
    receivers:
      - uid: grafana-default-receiver
        type: email
        disableResolveMessage: false

policies:
  - orgId: 1
    receiver: grafana-default
```

**Step 2: Remove alert-rules from Prometheus**

In `prometheus/prometheus.yaml`, remove the `rule_files` line. In `docker-compose.yml`, remove the `./prometheus/alert-rules.yaml` volume mount from the prometheus service. Delete `prometheus/alert-rules.yaml`.

**Step 3: Add explicit retention flag to Prometheus**

In `docker-compose.yml`, add `--storage.tsdb.retention.time=30d` to the prometheus command args.

**Step 4: Mount alerting provisioning in Grafana**

The existing Grafana volume mount `./grafana/provisioning:/etc/grafana/provisioning:ro` already covers the new `alerting/` subdirectory. No change needed.

**Step 5: Verify**

Run: `docker compose config --quiet` to validate YAML.

**Step 6: Commit**
```bash
git add grafana/provisioning/alerting/alerts.yaml prometheus/prometheus.yaml docker-compose.yml
git rm prometheus/alert-rules.yaml
git commit -m "feat(alerting): migrate to Grafana provisioned alerts, fix ServiceDown detection"
```

---

## Phase 2: Infrastructure Hardening & Self-Monitoring

### Task 2: Add health checks and resource limits to Docker Compose

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Add health checks and deploy limits to all 5 observability services**

For each service, add `healthcheck` and `deploy.resources.limits`:

**otel-collector:**
```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:13133/"]
  interval: 10s
  timeout: 5s
  retries: 3
deploy:
  resources:
    limits:
      memory: 512M
```

**tempo:**
```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:3200/ready"]
  interval: 10s
  timeout: 5s
  retries: 3
deploy:
  resources:
    limits:
      memory: 1G
```

**prometheus:**
```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:9090/-/healthy"]
  interval: 10s
  timeout: 5s
  retries: 3
deploy:
  resources:
    limits:
      memory: 1G
```

**loki:**
```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:3100/ready"]
  interval: 10s
  timeout: 5s
  retries: 3
deploy:
  resources:
    limits:
      memory: 1G
```

**grafana:**
```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/api/health"]
  interval: 10s
  timeout: 5s
  retries: 3
deploy:
  resources:
    limits:
      memory: 512M
```

Also change Loki from `user: "0"` to `user: "10001"`.

**Step 2: Verify**

Run: `docker compose config --quiet`

**Step 3: Commit**
```bash
git add docker-compose.yml
git commit -m "feat(infra): add health checks, resource limits, fix Loki root user"
```

---

### Task 3: Add OTel Collector extensions and self-monitoring

**Files:**
- Modify: `otel/otel-collector-config.yaml`
- Modify: `docker-compose.yml` (expose port 13133 for health)

**Step 1: Add extensions to collector config**

Add to `otel/otel-collector-config.yaml` before the `receivers` section:

```yaml
extensions:
  health_check:
    endpoint: "0.0.0.0:13133"
  zpages:
    endpoint: "0.0.0.0:55679"
```

In the `service` section, add:
```yaml
  extensions: [health_check, zpages]
```

**Step 2: Expose health check port in Docker Compose**

Add port `13133:13133` to the otel-collector service.

**Step 3: Commit**
```bash
git add otel/otel-collector-config.yaml docker-compose.yml
git commit -m "feat(otel): add health_check and zpages extensions"
```

---

### Task 4: Add Prometheus scrape configs for self-monitoring

**Files:**
- Modify: `prometheus/prometheus.yaml`

**Step 1: Add scrape_configs**

```yaml
scrape_configs:
  - job_name: otel-collector
    scrape_interval: 15s
    static_configs:
      - targets: ['otel-collector:8888']

  - job_name: tempo
    scrape_interval: 15s
    static_configs:
      - targets: ['tempo:3200']

  - job_name: loki
    scrape_interval: 15s
    static_configs:
      - targets: ['loki:3100']

  - job_name: prometheus
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:9090']
```

**Step 2: Commit**
```bash
git add prometheus/prometheus.yaml
git commit -m "feat(prometheus): add scrape configs for observability stack self-monitoring"
```

---

### Task 5: Pin Docker image tags

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Look up current stable versions and replace `:latest` tags**

Replace:
- `otel/opentelemetry-collector-contrib:latest` → `otel/opentelemetry-collector-contrib:0.118.0`
- `prom/prometheus:latest` → `prom/prometheus:v3.2.1`
- `grafana/loki:latest` → `grafana/loki:3.4.2`
- `grafana/grafana:latest` → `grafana/grafana:11.5.2`

Keep `grafana/tempo:2.7.2` (already pinned).

Check exact latest stable versions at time of implementation and use those.

**Step 2: Commit**
```bash
git add docker-compose.yml
git commit -m "chore(infra): pin all observability image tags to stable versions"
```

---

### Task 6: Sync K8s OTel Collector config and add KB service OTEL env vars

**Files:**
- Modify: `k8s/base/otel-collector/configmap.yaml`
- Modify: `k8s/base/kb-service/deployment.yaml`

**Step 1: Update K8s collector ConfigMap**

Replace the embedded config in `k8s/base/otel-collector/configmap.yaml` to match `otel/otel-collector-config.yaml` (including extensions, memory_limiter, resource processor, HTTP receiver on 4318, health_check extension).

**Step 2: Add OTEL env vars to KB service K8s deployment**

Add to `k8s/base/kb-service/deployment.yaml` env section:
```yaml
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://otel-collector:4318
- name: OTEL_SERVICE_NAME
  value: kb-service
```

**Step 3: Commit**
```bash
git add k8s/base/otel-collector/configmap.yaml k8s/base/kb-service/deployment.yaml
git commit -m "feat(k8s): sync collector config with docker-compose, add KB service OTEL vars"
```

---

## Phase 3: Tail Sampling & Recording Rules

### Task 7: Add tail sampling processor to OTel Collector

**Files:**
- Modify: `otel/otel-collector-config.yaml`

**Step 1: Add tail_sampling processor**

Add after the `batch` processor:
```yaml
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow-traces
        type: latency
        latency:
          threshold_ms: 500
      - name: auth-traces
        type: string_attribute
        string_attribute:
          key: service.name
          values: [auth-service]
      - name: probabilistic-sample
        type: probabilistic
        probabilistic:
          sampling_percentage: 10
```

**Step 2: Update traces pipeline**

Change the traces pipeline processors from:
```yaml
processors: [memory_limiter, resource, batch]
```
to:
```yaml
processors: [memory_limiter, resource, tail_sampling, batch]
```

**Step 3: Commit**
```bash
git add otel/otel-collector-config.yaml
git commit -m "feat(otel): add tail sampling - keep errors, slow traces, sample 10% rest"
```

---

### Task 8: Add Prometheus recording rules

**Files:**
- Create: `prometheus/recording-rules.yaml`
- Modify: `prometheus/prometheus.yaml`
- Modify: `docker-compose.yml` (mount recording-rules.yaml)

**Step 1: Create recording rules file**

```yaml
groups:
  - name: service_metrics
    interval: 30s
    rules:
      - record: service:request_rate:5m
        expr: sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))
      - record: service:error_rate:5m
        expr: sum by (service_name) (rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))
      - record: service:error_ratio:5m
        expr: |
          sum by (service_name) (rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))
          /
          sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))
      - record: service:p50_latency:5m
        expr: histogram_quantile(0.50, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))
      - record: service:p95_latency:5m
        expr: histogram_quantile(0.95, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))
      - record: service:p99_latency:5m
        expr: histogram_quantile(0.99, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))
```

**Step 2: Add rule_files to prometheus.yaml**

```yaml
rule_files:
  - /etc/prometheus/recording-rules.yaml
```

**Step 3: Mount recording-rules.yaml in Docker Compose**

Add to prometheus volumes:
```yaml
- ./prometheus/recording-rules.yaml:/etc/prometheus/recording-rules.yaml:ro
```

**Step 4: Commit**
```bash
git add prometheus/recording-rules.yaml prometheus/prometheus.yaml docker-compose.yml
git commit -m "feat(prometheus): add recording rules for pre-computed latency percentiles"
```

---

### Task 9: Update dashboard panels to use recording rules

**Files:**
- Modify: `grafana/provisioning/dashboards/nats-chat-overview.json`

**Step 1: Replace raw queries with recording rules**

In the overview dashboard JSON, update panel targets:

- "Request Rate by Service" panel: change `sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))` to `service:request_rate:5m`
- "Error Rate by Service" panel: change query to `service:error_rate:5m`
- "P95 Latency by Service" panel: change query to `service:p95_latency:5m`
- "P50 Latency by Service" panel: change query to `service:p50_latency:5m`

Also add a `$service` template variable:
```json
"templating": {
  "list": [
    {
      "name": "service",
      "type": "query",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "query": "label_values(traces_spanmetrics_calls_total, service_name)",
      "includeAll": true,
      "allValue": ".*",
      "current": { "text": "All", "value": "$__all" },
      "multi": true
    }
  ]
}
```

Update panel queries that filter by service to use `{service_name=~"$service"}`.

**Step 2: Commit**
```bash
git add grafana/provisioning/dashboards/nats-chat-overview.json
git commit -m "feat(grafana): use recording rules in overview dashboard, add service variable"
```

---

## Phase 4: Service Instrumentation Gaps

### Task 10: Add metrics to KB service

**Files:**
- Modify: `apps/kb/service/src/main/java/com/example/kb/NatsHandler.java`

**Step 1: Add metric fields**

Add imports and fields near the top of the class:
```java
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
```

Add fields:
```java
private final LongCounter requestCounter;
private final LongCounter errorCounter;
private final DoubleHistogram durationHistogram;
```

Initialize in constructor (after meter provider is available from OtelConfig):
```java
Meter meter = OtelConfig.getMeterProvider().get("kb-service");
this.requestCounter = meter.counterBuilder("kb_requests_total")
    .setDescription("Total KB requests").build();
this.errorCounter = meter.counterBuilder("kb_errors_total")
    .setDescription("Total KB errors").build();
this.durationHistogram = meter.histogramBuilder("kb_request_duration_seconds")
    .setDescription("KB request duration").setUnit("s").build();
```

**Step 2: Record metrics in each handler**

In each handler method (handleList, handleCreate, handleLoad, handleSave, handleDelete, handleEditing, handleStopEdit), add timing and counting:
```java
long startNanos = System.nanoTime();
Attributes attrs = Attributes.of(AttributeKey.stringKey("action"), "list");
try {
    // existing handler logic
    requestCounter.add(1, attrs);
} catch (Exception e) {
    errorCounter.add(1, attrs);
    throw e;
} finally {
    double durationSec = (System.nanoTime() - startNanos) / 1_000_000_000.0;
    durationHistogram.record(durationSec, attrs);
}
```

**Step 3: Expose MeterProvider from OtelConfig**

In `OtelConfig.java`, add a static getter for the MeterProvider so NatsHandler can access it:
```java
public static MeterProvider getMeterProvider() { return meterProvider; }
```

**Step 4: Verify build**

Run: `cd apps/kb/service && mvn package -DskipTests`

**Step 5: Commit**
```bash
git add apps/kb/service/
git commit -m "feat(kb): add request counter, error counter, duration histogram metrics"
```

---

### Task 11: Add span attributes to browser tracing

**Files:**
- Modify: `web/src/utils/tracing.ts`
- Modify: `web/src/components/ChatRoom.tsx`
- Modify: `web/src/components/ThreadPanel.tsx`
- Modify: `web/src/providers/MessageProvider.tsx`

**Step 1: Update startActionSpan to accept attributes**

In `tracing.ts`, change the signature:
```typescript
export function startActionSpan(
  name: string,
  attrs?: Record<string, string>
): { ctx: any; end: (error?: Error) => void } {
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL });
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => span.setAttribute(k, v));
  }
  // ... rest unchanged
}
```

**Step 2: Update all call sites to pass room/user/action attributes**

In ChatRoom.tsx, for each `startActionSpan` call, add attributes. Example for handleSend:
```typescript
const action = startActionSpan('send_message', {
  'chat.room': room,
  'chat.user': userInfo.username,
  'chat.action': 'send',
});
```

Apply same pattern to: handleEdit (action: 'edit'), handleDelete (action: 'delete'), handleReact (action: 'react'), handleTranslate (action: 'translate').

In ThreadPanel.tsx: send_thread_reply (action: 'thread_reply'), edit_thread_message (action: 'thread_edit'), delete_thread_message (action: 'thread_delete'), react_thread_message (action: 'thread_react').

In MessageProvider.tsx: join_room (action: 'join', chat.room: room).

**Step 3: Verify build**

Run: `cd web && npm run build`

**Step 4: Commit**
```bash
git add web/src/
git commit -m "feat(web): add chat.room, chat.user, chat.action attributes to browser spans"
```

---

### Task 12: Add OTel to whiteboard service

**Files:**
- Modify: `apps/whiteboard/service/package.json`
- Create: `apps/whiteboard/service/src/tracing.ts`
- Modify: `apps/whiteboard/service/src/index.ts`
- Modify: `docker-compose.yml`
- Modify: `k8s/base/whiteboard-service/deployment.yaml`

**Step 1: Install OTel packages**

```bash
cd apps/whiteboard/service
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-grpc @opentelemetry/exporter-metrics-otlp-grpc @opentelemetry/resources @opentelemetry/semantic-conventions
```

**Step 2: Create tracing.ts init file**

Create `apps/whiteboard/service/src/tracing.ts`:
```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'whiteboard-service',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
    }),
  }),
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
```

**Step 3: Import tracing at top of index.ts**

Add as the very first line of `apps/whiteboard/service/src/index.ts`:
```typescript
import './tracing';
```

**Step 4: Add OTEL env vars to Docker Compose and K8s**

In `docker-compose.yml`, add to whiteboard-service environment:
```yaml
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_SERVICE_NAME: whiteboard-service
```

Add `depends_on: [otel-collector]`.

In `k8s/base/whiteboard-service/deployment.yaml`, add env vars:
```yaml
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://otel-collector:4317
- name: OTEL_SERVICE_NAME
  value: whiteboard-service
```

**Step 5: Verify build**

Run: `cd apps/whiteboard/service && npm run build`

**Step 6: Commit**
```bash
git add apps/whiteboard/service/ docker-compose.yml k8s/base/whiteboard-service/deployment.yaml
git commit -m "feat(whiteboard): add OpenTelemetry SDK auto-instrumentation"
```

---

### Task 13: Add target_lang attribute to translation service metrics

**Files:**
- Modify: `translation-service/main.go`

**Step 1: Add attribute to metric recording**

Find the lines where `translateCounter.Add` and `translateDuration.Record` are called (around lines 215-216). Change from:
```go
translateCounter.Add(ctx, 1)
translateDuration.Record(ctx, duration)
```
to:
```go
langAttr := attribute.String("target_lang", req.TargetLang)
translateCounter.Add(ctx, 1, metric.WithAttributes(langAttr))
translateDuration.Record(ctx, duration, metric.WithAttributes(langAttr))
```

**Step 2: Verify build**

Run: `cd translation-service && go build .`

**Step 3: Commit**
```bash
git add translation-service/main.go
git commit -m "feat(translation): add target_lang attribute to metrics"
```

---

## Phase 5: New Dashboards

### Task 14: Create infrastructure health dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-infra.json`

**Step 1: Create dashboard JSON**

Dashboard: "NATS Chat - Infrastructure Health", uid: `nats-chat-infra`, tags: `["nats-chat", "infrastructure"]`

**Panels:**

1. **OTel Collector - Spans Received** (timeseries, prometheus)
   - `rate(otelcol_receiver_accepted_spans[5m])`
2. **OTel Collector - Spans Exported** (timeseries, prometheus)
   - `rate(otelcol_exporter_sent_spans[5m])`
3. **OTel Collector - Export Errors** (timeseries, prometheus)
   - `rate(otelcol_exporter_send_failed_spans[5m])`
4. **Tempo - Query Latency** (timeseries, prometheus)
   - `histogram_quantile(0.95, rate(tempo_request_duration_seconds_bucket[5m]))`
5. **Tempo - WAL Size** (stat, prometheus)
   - `tempo_ingester_bytes_received_total`
6. **Loki - Ingestion Rate** (timeseries, prometheus)
   - `rate(loki_distributor_bytes_received_total[5m])`
7. **Loki - Dropped Logs** (timeseries, prometheus)
   - `rate(loki_distributor_lines_received_total{status="dropped"}[5m])`
8. **Prometheus - TSDB Size** (stat, prometheus)
   - `prometheus_tsdb_storage_blocks_bytes`
9. **Prometheus - Rule Evaluation Duration** (timeseries, prometheus)
   - `rate(prometheus_rule_evaluation_duration_seconds_sum[5m])`

Layout: 3 columns per row, 8 tall per panel.

**Step 2: Commit**
```bash
git add grafana/provisioning/dashboards/nats-chat-infra.json
git commit -m "feat(grafana): add infrastructure health dashboard for meta-observability"
```

---

### Task 15: Create translation service dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-translation.json`

**Step 1: Create dashboard JSON**

Dashboard: "NATS Chat - Translation Service", uid: `nats-chat-translation`, tags: `["nats-chat"]`

**Panels:**

1. **Request Rate by Language** (timeseries, prometheus)
   - `sum by (target_lang) (rate(translate_requests_total[5m]))`
2. **Duration P50/P95/P99** (timeseries, prometheus)
   - `histogram_quantile(0.5/0.95/0.99, sum by (le) (rate(translate_duration_seconds_bucket[5m])))`
3. **Error Rate** (timeseries, prometheus)
   - `service:error_rate:5m{service_name="translation-service"}`
4. **Translation Traces** (traces, tempo)
   - TraceQL: `{resource.service.name="translation-service"}`
5. **Translation Logs** (logs, loki)
   - `{service_name="translation-service"} | json`

**Step 2: Commit**
```bash
git add grafana/provisioning/dashboards/nats-chat-translation.json
git commit -m "feat(grafana): add translation service dashboard"
```

---

### Task 16: Create sticker & search combined dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-sticker-search.json`

**Step 1: Create dashboard JSON**

Dashboard: "NATS Chat - Sticker & Search", uid: `nats-chat-sticker-search`, tags: `["nats-chat"]`

**Panels:**

1. **Sticker Requests/sec** (timeseries, prometheus)
   - `sum by (type) (rate(sticker_requests_total[5m]))`
2. **Sticker Latency P95** (timeseries, prometheus)
   - `histogram_quantile(0.95, sum by (le) (rate(sticker_request_duration_seconds_bucket[5m])))`
3. **User Search Requests/sec** (timeseries, prometheus)
   - `rate(user_search_requests_total[5m])`
4. **User Search Latency P95** (timeseries, prometheus)
   - `histogram_quantile(0.95, sum by (le) (rate(user_search_duration_seconds_bucket[5m])))`
5. **Sticker & Search Traces** (traces, tempo)
   - TraceQL: `{resource.service.name=~"sticker-service|user-search-service"}`
6. **Sticker & Search Logs** (logs, loki)
   - `{service_name=~"sticker-service|user-search-service"} | json`

**Step 2: Commit**
```bash
git add grafana/provisioning/dashboards/nats-chat-sticker-search.json
git commit -m "feat(grafana): add sticker & search combined dashboard"
```

---

### Task 17: Final verification

**Step 1: Validate all configs**

```bash
docker compose config --quiet
cd web && npm run build
cd apps/kb/service && mvn package -DskipTests
cd apps/whiteboard/service && npm run build
cd translation-service && go build .
```

**Step 2: Validate all JSON dashboards**

```bash
for f in grafana/provisioning/dashboards/*.json; do python3 -m json.tool "$f" > /dev/null && echo "OK: $f" || echo "FAIL: $f"; done
```

**Step 3: Final commit if any fixups needed**
```bash
git add -A
git commit -m "chore: final verification and fixups for observability v2"
```
