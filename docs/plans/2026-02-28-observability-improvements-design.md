# Observability Improvements Design

**Date:** 2026-02-28
**Approach:** Incremental Enhancement (Approach A)
**Scope:** End-to-end tracing, error debugging, performance visibility, latency monitoring

## Goals

- End-to-end request flow: browser action → NATS → backend → DB → response visible in a single Tempo trace
- Error debugging: error spans, failed requests, correlated logs
- Performance visibility: P50/P95/P99 latencies per service, slow request detection
- Latency monitoring: request/reply round-trip times, browser-perceived latency, DB query times
- Structured logs with trace_id/span_id correlation to Loki
- Grafana dashboards: service map + trace explorer + per-service dashboards
- Alerting rules for errors, latency, service health

## Section 1: Browser-Side Tracing

### 1a. Add OpenTelemetry JS SDK

Add to `web/`:
- `@opentelemetry/sdk-trace-web`
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/resources`

Create `web/src/lib/otel.ts`:
- Initialize `WebTracerProvider` with OTLP HTTP exporter
- Export `tracer` instance used throughout the app
- Exporter target: OTel Collector via `/otlp` proxy route (K8s) or direct `VITE_OTLP_ENDPOINT` (Docker Compose)

### 1b. Refactor tracedHeaders() to create real spans

Replace random ID generation with real OTel spans:
```
tracedPublish(nc, subject, data, spanName):
  span = tracer.startSpan(spanName, { kind: PRODUCER })
  inject trace context into NATS headers
  nc.publish(subject, data, { headers })
  span.end()
```

Each NATS publish creates a browser-originated span visible in Tempo with proper parent/child linking to backend spans.

### 1c. Wrap key user actions in parent spans

Higher-level spans grouping related publishes:
- "send message" — wraps chat publish + thread broadcast
- "join room" — wraps room.join + history fetch + presence query
- "OIDC login" — wraps Keycloak redirect flow
- "NATS connect" — wraps WebSocket connection + auth

### 1d. OTLP export route

- K8s: Add `/otlp/` location in `web/nginx.conf` proxying to `otel-collector:4318`
- Docker Compose: Expose port 4318 on collector, use `VITE_OTLP_ENDPOINT`

### 1e. Browser-perceived latency spans

Record durations for user-facing operations:
- Send message → see it in chat
- Join room → room loaded with history
- Fetch history → messages rendered
- Request/reply round-trips (history, presence, search)

## Section 2: Go Services Tracing Enhancement

### 2a. Consistent error recording

All service handlers get:
```go
if err != nil {
    span.RecordError(err)
    span.SetStatus(codes.Error, err.Error())
}
```

Services: fanout, room, presence, persist-worker, history, user-search, translation, sticker, app-registry, poll

### 2b. Span events for key operations

- fanout-service: cache_miss, cache_hit, rate_limited, thread_fanout_start
- room-service: kv_create, kv_delete, access_denied, room_created
- presence-service: heartbeat_received, connection_expired, status_changed
- persist-worker: message_persisted, persist_error

### 2c. Standardized span attributes

| Attribute | Example | Used by |
|-----------|---------|---------|
| `chat.room` | `general` | All room-related services |
| `chat.user` | `alice` | All services with user context |
| `chat.action` | `send`, `edit`, `delete` | fanout, persist, history |
| `chat.thread_id` | `general-1234` | fanout, persist, history |

### 2d. External HTTP call tracing in auth-service

Add `otelhttp.NewTransport()` wrapper in `keycloak.go` so JWKS fetches appear as child spans.

### 2e. Database span enhancement

Ensure all PostgreSQL-backed services use `otelsql`: room-service, sticker-service, app-registry-service, poll-service (persist-worker and history-service already use it).

### 2f. Consistent histogram buckets

All `*_duration_seconds` histograms use NATS-tuned buckets: 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s.

## Section 3: Java KB Service Instrumentation

### 3a. OpenTelemetry Java Agent

In `apps/kb/service/Dockerfile`:
- Download `opentelemetry-javaagent.jar`
- Add `-javaagent:/app/opentelemetry-javaagent.jar` to JVM startup

Environment variables in docker-compose.yml:
```
OTEL_SERVICE_NAME: kb-service
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_TRACES_EXPORTER: otlp
OTEL_METRICS_EXPORTER: otlp
OTEL_LOGS_EXPORTER: otlp
```

Auto-instruments: JDBC (PostgreSQL), Spring scheduling, SLF4J logging.

### 3b. Manual NATS trace propagation

Create `NatsTracing.java` utility (mirrors Go otelhelper/nats.go):
- `extractContext(Message msg)` — extract traceparent from NATS headers
- `startServerSpan(Context ctx, String subject)` — create SERVER span
- `tracedPublish(Connection nc, String subject, byte[] data, Context ctx)` — inject + publish

Update `NatsHandler.java` to use these in all handlers.

### 3c. KB-specific span attributes

Standard attributes (`chat.room`, `chat.user`) plus:
- `kb.page_id` — page being operated on
- `kb.action` — list/create/load/save/delete/editing/stopedit

## Section 4: Infrastructure Config Improvements

### 4a. OTel Collector (`otel/otel-collector-config.yaml`)

Add processors:
- `memory_limiter`: limit 512MB, spike 256MB
- `resource`: add `deployment.environment: dev`
- `batch`: reduce timeout to 2s

Pipeline: `otlp → memory_limiter → resource → batch → exporters`

### 4b. Tempo (`tempo/tempo.yaml`)

- Retention: 168h (7 days)
- Search tags: `chat.room`, `chat.user`, `chat.action`, `service.name`
- Metrics generator: auto-generate `traces_spanmetrics_*` from spans (RED metrics)

### 4c. Loki (`loki/loki.yaml`)

- Retention: 168h (7 days)
- Rate limiting: 4MB/s ingestion limit

### 4d. Prometheus (`prometheus/prometheus.yaml`)

- Recording rules: pre-compute P50/P95/P99 latencies from histograms

## Section 5: Grafana Dashboards

All dashboards auto-provisioned as JSON in `grafana/provisioning/dashboards/`.

### 5a. Overview Dashboard — "NATS Chat - Service Overview"

| Panel | Type | Source | Shows |
|-------|------|--------|-------|
| Service Map | Node Graph | Tempo | Service dependencies with edge latencies |
| Trace Explorer | Table + Trace | Tempo | Search by service/room/user/action |
| Error Rate | Time Series | Prometheus | Error spans/sec per service |
| Request Rate | Time Series | Prometheus | Requests/sec per service |
| P95 Latency | Time Series | Prometheus | 95th percentile latency per service |
| Recent Errors | Logs | Loki | Error logs with trace_id links |

### 5b. Per-Service Dashboards

**"NATS Chat - Auth Service":**
- Auth requests/sec (browser vs service), latency histogram, rejection rate + reasons, JWKS fetch latency, recent errors

**"NATS Chat - Message Pipeline":**
- Fanout throughput (multicast vs per-user), persist-worker write rate + errors, history query latency, end-to-end message latency, JetStream consumer lag

**"NATS Chat - Rooms & Presence":**
- Room join/leave rate, active rooms gauge, presence heartbeat rate, online users, KV operation latency

**"NATS Chat - Apps":**
- App registry requests, poll operations, KB operations, per-app latency

## Section 6: Alerting Rules

### Prometheus alert rules (`prometheus/alert-rules.yaml`)

| Alert | Condition | Severity |
|-------|-----------|----------|
| HighErrorRate | Error rate > 5% for any service over 5 min | critical |
| SlowRequests | P95 latency > 2s for any service over 5 min | warning |
| PersistWorkerErrors | persist errors increase > 0 over 5 min | critical |
| AuthRejectionSpike | Auth rejection rate > 20% over 5 min | warning |
| ServiceDown | No metrics from a service for 2 min | critical |
| HighFanoutLatency | Fanout P95 > 500ms over 5 min | warning |
| JetStreamConsumerLag | Consumer pending > 1000 | warning |

Alerts visualized in overview dashboard with color-coded status.

## Section 7: Structured Logging with Trace Correlation

### 7a. Go services — structured JSON logging

- All services use `slog.InfoContext(ctx, ...)` (passing span context)
- Switch to `slog.NewJSONHandler` for structured output
- Standardize fields: `service`, `room`, `user`, `action`, `error`
- `tracingHandler` continues injecting `trace_id` and `span_id`

### 7b. Java KB service logging

- OTel Java agent auto-bridges SLF4J → OTel log exporter
- Configure logback for JSON output with trace context fields

### 7c. Loki query templates

Pre-built Explore queries:
- `{service_name="fanout-service"} | json | level="ERROR"` — service errors
- `{service_name=~".+"} | json | trace_id="<id>"` — all logs for a trace
- `{service_name=~".+"} | json | room="general"` — all logs for a room

## Section 8: Latency Monitoring

### Request/reply latency tracking

| Metric | Service | What |
|--------|---------|------|
| End-to-end message latency | Browser → persist-worker | Send click → PostgreSQL write |
| NATS request/reply latency | All services | Round-trip: history, members, search, presence, stickers, apps |
| Fanout latency | fanout-service | Receive → all deliveries complete |
| DB query latency | All PostgreSQL services | Per-query via otelsql |
| Auth callout latency | auth-service | JWT/credential validation time |
| Browser-perceived latency | Web (OTel JS) | User action → UI update |

### Histogram bucket tuning

All `*_duration_seconds` use NATS-tuned buckets: 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s.

### Dashboard integration

- Overview dashboard: P50/P95/P99 per service
- Per-service dashboards: latency histograms + percentile breakdowns
- Alert: SlowRequests fires when P95 > 2s

## Expected Result

In Tempo, a "send message" trace looks like:
```
[browser] send message (150ms)
  +-- [browser] NATS publish chat.general (5ms)
      +-- [fanout-service] fanout notify (12ms)
          |-- [fanout-service] NATS publish room.msg.general (2ms)
          +-- [persist-worker] JetStream consume (8ms)
              +-- [persist-worker] PostgreSQL INSERT (3ms)
```

Click any span → see correlated logs in Loki.
Click any error log → jump to full trace in Tempo.
Overview dashboard shows service map, error rates, P95 latencies, and alerts.
