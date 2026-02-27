# Observability & Monitoring Recommendations

**Date:** 2026-02-27
**Scope:** OTel instrumentation, metrics, tracing, logging, alerting, dashboards

---

## Current State

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Go Services (12) + Browser (React)                    │
│                          OTel SDK (OTLP/gRPC)                            │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ :4317
                    ┌───────────▼───────────┐
                    │    OTel Collector     │
                    │ (contrib:latest)      │
                    └─────┬─────┬─────┬─────┘
                          │     │     │
         ┌────────────────┘     │     └────────────────┐
         ▼                      ▼                      ▼
   ┌──────────┐          ┌────────────┐          ┌─────────┐
   │  Tempo   │          │ Prometheus │          │  Loki   │
   │ (traces) │          │ (metrics)  │          │ (logs)  │
   └────┬─────┘          └─────┬──────┘          └────┬────┘
        └──────────────────────┼───────────────────────┘
                         ┌─────▼─────┐
                         │  Grafana  │ :3001
                         └───────────┘
```

### Coverage Summary

| Service | Language | Traces | Metrics | Logs | Trace Propagation |
|---------|----------|--------|---------|------|-------------------|
| auth-service | Go | ✅ | ✅ | ✅ | ✅ |
| fanout-service | Go | ✅ | ✅ | ✅ | ✅ |
| room-service | Go | ✅ | ✅ | ✅ | ✅ |
| presence-service | Go | ✅ | ✅ | ✅ | ✅ |
| persist-worker | Go | ✅ | ✅ | ✅ | ✅ |
| history-service | Go | ✅ | ✅ | ✅ | ✅ |
| user-search-service | Go | ✅ | ✅ | ✅ | ✅ |
| translation-service | Go | ✅ | ✅ | ✅ | ✅ |
| sticker-service | Go | ✅ | ✅ | ✅ | ✅ |
| app-registry-service | Go | ✅ | ✅ | ✅ | ✅ |
| poll-service | Go | ✅ | ✅ | ✅ | ✅ |
| read-receipt-service | Go | ✅ | ✅ | ✅ | ✅ |
| **kb-service** | Java | ❌ | ❌ | ⚠️ | ❌ |
| **whiteboard-service** | Node.js | ❌ | ❌ | ⚠️ | ❌ |
| **browser** | React | ⚠️ | ❌ | ❌ | ✅ |

Legend: ✅ Full support | ⚠️ Partial | ❌ Missing

---

## Critical Gaps

### 1. Java KB Service - No OTel Instrumentation

**Issue:** `apps/kb/service/` has no OpenTelemetry dependencies or instrumentation.

**Impact:** Breaks end-to-end tracing for knowledge base operations. 25% of room apps have no observability.

**Recommendation:**
```xml
<!-- Add to pom.xml -->
<dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-instrumentation-bom</artifactId>
    <version>2.10.0</version>
    <type>pom</type>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-nats-2.0-java</artifactId>
</dependency>
```

**Implementation:**
1. Add OTel Java agent or manual instrumentation
2. Extract trace context from NATS headers (similar to Go `StartConsumerSpan`)
3. Create spans for `list`, `create`, `load`, `save`, `delete` handlers
4. Add metrics: `kb_requests_total`, `kb_request_duration_seconds`

---

### 2. Node.js Whiteboard Service - No OTel Instrumentation

**Issue:** `apps/whiteboard/service/` uses `console.log()` and has no OTel SDK.

**Impact:** Breaks tracing for whiteboard collaboration features.

**Recommendation:**
```bash
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/exporter-metrics-otlp-grpc
```

**Implementation:**
1. Initialize OTel SDK at startup
2. Create `tracedSubscribe()` helper (similar to Go `otelhelper`)
3. Add metrics: `whiteboard_operations_total`, `whiteboard_clients_active`

---

### 3. No Kubernetes Observability Stack

**Issue:** `k8s/` directory has no observability manifests. Prometheus, Tempo, Loki, Grafana only exist in Docker Compose.

**Impact:** K8s deployments have no monitoring.

**Recommendation:** Create `k8s/base/observability/` with:

```
k8s/base/observability/
├── kustomization.yaml
├── namespace.yaml
├── otel-collector/
│   ├── deployment.yaml
│   ├── configmap.yaml
│   └── service.yaml
├── prometheus/
│   ├── statefulset.yaml
│   ├── configmap.yaml
│   └── service.yaml
├── tempo/
│   ├── statefulset.yaml
│   ├── configmap.yaml
│   └── service.yaml
├── loki/
│   ├── statefulset.yaml
│   ├── configmap.yaml
│   └── service.yaml
└── grafana/
    ├── deployment.yaml
    ├── configmap-datasources.yaml
    ├── configmap-dashboards.yaml
    └── service.yaml
```

---

### 4. No Alerting Rules

**Issue:** Prometheus has no alerting configuration.

**Impact:** Issues only discovered through manual dashboard inspection.

**Recommendation:** Create `prometheus/alerting_rules.yml`:

```yaml
groups:
  - name: nats-chat-critical
    rules:
      - alert: MessagePersistErrors
        expr: rate(messages_persist_errors_total[5m]) > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Message persistence errors detected"
          description: "{{ $value }} errors/sec in persist-worker"

      - alert: FanoutDrops
        expr: rate(fanout_drops_total[5m]) > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Messages dropped from fanout queue"

      - alert: HighAuthLatency
        expr: histogram_quantile(0.99, rate(auth_request_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Auth request p99 latency > 500ms"

      - alert: AuthServiceNoLeader
        expr: count(auth_service_is_leader == 1) == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "No auth-service leader elected"

      - alert: RateLimitCircuitBreakerOpen
        expr: fanout_rate_limit_circuit_breaker_state == 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Rate limiting circuit breaker is open"

  - name: nats-chat-slos
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(messages_persist_errors_total[5m])) /
          sum(rate(messages_persisted_total[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate exceeds 1% SLO"
```

---

### 5. Limited Grafana Dashboard Coverage

**Issue:** Current dashboard only covers auth-service, persist-worker, history-service.

**Impact:** 9 Go services + 2 polyglot services have no visualization.

**Recommendation:** Expand dashboard with service rows:

```json
{
  "title": "Fanout Service",
  "type": "row",
  "panels": [
    {"title": "Messages Fanned Out", "type": "stat", "targets": [{"expr": "rate(fanout_messages_total[5m])"}]},
    {"title": "Rate Limited", "type": "stat", "targets": [{"expr": "rate(fanout_rate_limited_total[5m])"}]},
    {"title": "Dropped", "type": "stat", "targets": [{"expr": "rate(fanout_drops_total[5m])"}]},
    {"title": "Cached Rooms", "type": "stat", "targets": [{"expr": "fanout_room_count"}]}
  ]
}
```

Add rows for: room-service, presence-service, translation-service, poll-service, app-registry-service, sticker-service, read-receipt-service, user-search-service.

---

## Medium Priority Improvements

### 6. Add Trace Sampling for Production

**Issue:** All traces captured, no sampling. Will overwhelm storage at scale.

**Recommendation:** Add to OTel Collector config:

```yaml
processors:
  probabilistic_sampler:
    sampling_percentage: 10  # 10% sampling for production
    
service:
  pipelines:
    traces:
      processors: [probabilistic_sampler, batch]
```

For dev, set to 100%. For production, 1-10% based on traffic.

---

### 7. Scrape OTel Collector Metrics

**Issue:** OTel Collector exposes metrics at :8889 but Prometheus doesn't scrape them.

**Impact:** No visibility into collector health, throughput, or retries.

**Recommendation:** Add to `prometheus/prometheus.yaml`:

```yaml
scrape_configs:
  - job_name: 'otel-collector'
    static_configs:
      - targets: ['otel-collector:8889']
```

Key metrics to monitor:
- `otelcol_receiver_accepted_spans`
- `otelcol_exporter_sent_spans`
- `otelcol_processor_spans_dropped`

---

### 8. Add Service Health Metrics

**Issue:** Services don't expose health indicators (DB/NATS connection status).

**Recommendation:** Add to each Go service:

```go
healthGauge, _ := meter.Int64ObservableGauge("service_healthy",
    metric.WithDescription("Service health (1=healthy, 0=unhealthy)"))
_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
    healthy := 1
    if nc == nil || nc.Status() != nats.CONNECTED {
        healthy = 0
    }
    if db == nil || db.Ping() != nil {
        healthy = 0
    }
    o.ObserveInt64(healthGauge, int64(healthy), metric.WithAttributes(
        attribute.String("service", serviceName),
    ))
    return nil
}, healthGauge)
```

---

### 9. Enhanced Trace Attributes

**Issue:** Some spans lack useful attributes for debugging.

**Recommendation:** Add consistent attributes:

```go
span.SetAttributes(
    attribute.String("user.id", userId),           // Consistent naming
    attribute.String("chat.message_type", msgType), // text, sticker, edit, delete, react
    attribute.String("chat.room_type", roomType),   // public, private, dm
    attribute.Bool("chat.thread", isThread),
)
```

---

### 10. Browser Metrics Export

**Issue:** Browser only generates trace context, no metrics exported.

**Impact:** No client-side performance visibility (render time, WebSocket latency).

**Recommendation:** Add browser metrics via NATS publish:

```typescript
// web/src/utils/metrics.ts
export function recordLatency(operation: string, durationMs: number) {
  nc.publish('browser.metrics.latency', JSON.stringify({
    operation,
    duration: durationMs,
    user: userInfo?.username,
  }));
}
```

Create `browser-metrics-service` to aggregate and export to OTel.

---

## Low Priority Enhancements

### 11. Service-Level Dashboards

Create per-service dashboards with RED metrics:
- **R**ate (requests/sec)
- **E**rrors (error rate %)
- **D**uration (p50, p95, p99 latency)

### 12. Error Budget Tracking

Add SLO dashboards:
- 99.9% availability budget
- Latency budget (p99 < 500ms)
- Error budget burn rate

### 13. Distributed Trace Visualization

Add service graph to Grafana:
- Node graph showing service dependencies
- Edge labels with request rates
- Color-coded by error rate

### 14. Log-Based Metrics

Create metrics from logs:
- Error count by service
- Warning trends
- Slow operation detection

### 15. Custom Span Events

Add more span events for debugging:
```go
span.AddEvent("cache_hit", attribute.String("key", key))
span.AddEvent("db_query_start", attribute.String("query", queryType))
span.AddEvent("nats_publish", attribute.String("subject", subject))
```

---

## Implementation Priority

| # | Recommendation | Priority | Effort | Impact |
|---|----------------|----------|--------|--------|
| 1 | Java KB Service OTel | Critical | Medium | High |
| 2 | Node.js Whiteboard OTel | Critical | Medium | High |
| 3 | Kubernetes Observability | Critical | High | High |
| 4 | Alerting Rules | Critical | Low | High |
| 5 | Expand Dashboard | High | Medium | Medium |
| 6 | Trace Sampling | Medium | Low | High |
| 7 | Collector Metrics | Medium | Low | Medium |
| 8 | Health Metrics | Medium | Low | Medium |
| 9 | Enhanced Attributes | Low | Low | Low |
| 10 | Browser Metrics | Low | Medium | Medium |

---

## Quick Wins (Can implement in <1 hour)

1. **Alerting rules** - Copy suggested config to `prometheus/alerting_rules.yml`
2. **Collector metrics scraping** - Add 3-line scrape config
3. **Trace sampling** - Add 5-line processor config

---

## Architecture Decision Records (ADRs)

Consider documenting these decisions:

1. **OTLP Native** - Using OTLP for all three signals (traces, metrics, logs)
2. **Shared Helper Module** - Centralizing OTel NATS propagation in `pkg/otelhelper/`
3. **Browser Zero-Dependency** - Using `crypto.getRandomValues()` instead of OTel JS SDK
4. **Log-Trace Correlation** - `tracingHandler` wrapper for automatic trace_id injection
5. **Prometheus Remote Write** - Using OTel Collector to push metrics instead of scraping

---

## References

- [OpenTelemetry Go SDK](https://opentelemetry.io/docs/languages/go/)
- [OpenTelemetry Java Agent](https://opentelemetry.io/docs/languages/java/automatic/)
- [OpenTelemetry Node.js](https://opentelemetry.io/docs/languages/js/)
- [NATS Trace Propagation](https://docs.nats.io/using-nats/developer/develop_jetstream/observability)
- [Grafana Tempo](https://grafana.com/docs/tempo/latest/)
- [Prometheus Alerting Rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
