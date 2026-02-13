# Distributed Tracing Design

**Goal:** Add full observability (traces, metrics, logs) to the nats-chat-keycloak project using OpenTelemetry, Grafana, Tempo, Prometheus, and Loki.

## Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ auth-service │  │persist-worker│  │history-service│
│  (OTel SDK)  │  │  (OTel SDK)  │  │  (OTel SDK)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────OTLP/gRPC─────────────────┘
                         │
                ┌────────▼────────┐
                │  OTel Collector │
                │ (otel-collector)│
                └──┬─────┬─────┬─┘
                   │     │     │
          ┌────────┘     │     └────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌────────────┐  ┌─────────┐
    │  Tempo   │  │ Prometheus │  │  Loki   │
    │ (traces) │  │ (metrics)  │  │ (logs)  │
    └────┬─────┘  └─────┬──────┘  └────┬────┘
         └──────────────┼───────────────┘
                   ┌────▼────┐
                   │ Grafana │ :3001
                   └─────────┘
```

All Go services export telemetry via OTLP/gRPC to a central OpenTelemetry Collector, which routes traces to Tempo, metrics to Prometheus, and logs to Loki. Grafana on port 3001 queries all three backends with pre-provisioned datasources.

## Decisions

- **Collector topology:** Central OTel Collector (standard `otel/opentelemetry-collector-contrib`). Single OTLP endpoint for all services, collector handles batching/retry/routing.
- **Trace backend:** Grafana Tempo (lightweight, native Grafana integration, no external DB).
- **Metrics backend:** Prometheus (scraped from OTel Collector's Prometheus exporter).
- **Logs backend:** Grafana Loki.
- **NATS version:** Upgrade from 2.10 to 2.12. Gains built-in server-side message tracing (`Nats-Trace-Dest` header, introduced in 2.11), per-message TTLs, atomic batch publishes, and delayed scheduling.
- **Instrumentation scope:** All 3 Go services (auth-service, persist-worker, history-service). Web frontend not instrumented (propagates trace context only via NATS headers).

## NATS Trace Context Propagation

NATS has no official OTel auto-instrumentation library. We use a custom `NatsHeaderCarrier` adapter implementing `propagation.TextMapCarrier` to inject/extract W3C Trace Context (`traceparent`, `tracestate`) via NATS message headers.

Reference: https://oneuptime.com/blog/post/2026-02-06-trace-nats-message-streams-opentelemetry/view

### NatsHeaderCarrier

Wraps `nats.Header` with `Get(key)`, `Set(key, value)`, `Keys()` methods to satisfy the `TextMapCarrier` interface.

### Helper functions

- **`TracedPublish(ctx, nc, subject, data)`** — Starts a `SpanKindProducer` span, injects context into NATS headers, publishes via `PublishMsg`.
- **`TracedSubscribe` wrapper** — Extracts context from incoming message headers, starts a `SpanKindConsumer` span linked to the producer.
- **`TracedRequest(ctx, nc, subject, data)`** — `SpanKindClient` span for request/reply callers.
- **`TracedRespond` wrapper** — `SpanKindServer` span for request/reply responders (history-service).

Span attributes follow OTel messaging semantic conventions:
- `messaging.system = "nats"`
- `messaging.destination.name = <subject>`
- `messaging.message.payload_size_bytes = <len>`
- `messaging.consumer.name` (JetStream only)

JetStream headers persist with messages, so trace context survives replays and redeliveries.

### NATS 2.11+ Built-in Tracing

Complementary to OTel application-level traces. The `Nats-Trace-Dest` header enables server-side tracing of message routing (ingress, egress, stream exports, service imports) without code changes. Useful for operator-level debugging.

Reference: https://www.synadia.com/blog/message-tracing-nats

## Go Service Instrumentation

### Shared setup (all 3 services)

- OTel SDK initialization: `TracerProvider` + `MeterProvider` + `LoggerProvider` with OTLP/gRPC exporters
- `OTEL_EXPORTER_OTLP_ENDPOINT` env var (default: `otel-collector:4317`)
- `OTEL_SERVICE_NAME` env var per service
- Graceful shutdown of OTel providers

### Traces

| Service | Traced Operations |
|---------|-------------------|
| auth-service | Auth callout handler, Keycloak JWT validation, XKey decrypt, permission mapping, NATS respond |
| persist-worker | JetStream consume (per message), PostgreSQL insert, ack/nak |
| history-service | Request handler, PostgreSQL query, NATS respond |

PostgreSQL: Use `otelsql` (`github.com/XSAM/otelsql`) to wrap `database/sql` for automatic query spans.

### Metrics

| Metric | Type | Service |
|--------|------|---------|
| `messages_persisted_total` | Counter | persist-worker |
| `messages_persist_errors_total` | Counter | persist-worker |
| `history_requests_total` | Counter | history-service |
| `history_request_duration_seconds` | Histogram | history-service |
| `auth_requests_total` (by result) | Counter | auth-service |
| `auth_request_duration_seconds` | Histogram | auth-service |
| Go runtime metrics | Auto | all |

### Logs

Replace `log.Printf` with `slog` (Go stdlib structured logger) bridged to OTel Logs SDK via `otelslog` bridge. Logs automatically get `trace_id` and `span_id` fields attached when emitted within a span context. Exported to Loki via the collector.

## New Infrastructure Containers

| Container | Image | Port | Config |
|-----------|-------|------|--------|
| otel-collector | `otel/opentelemetry-collector-contrib` | 4317 (gRPC), 8889 (Prometheus metrics) | `otel/otel-collector-config.yaml` |
| tempo | `grafana/tempo:latest` | 3200 | `tempo/tempo.yaml` |
| prometheus | `prom/prometheus:latest` | 9090 | `prometheus/prometheus.yaml` — scrapes OTel Collector |
| loki | `grafana/loki:latest` | 3100 | `loki/loki.yaml` |
| grafana | `grafana/grafana:latest` | 3001 | Provisioned datasources + dashboards |

## Grafana Provisioning

- **Datasources** (auto-provisioned via `grafana/provisioning/datasources/`):
  - Tempo (traces) at `http://tempo:3200`
  - Prometheus (metrics) at `http://prometheus:9090`
  - Loki (logs) at `http://loki:3100`
- **Dashboard**: Service overview — trace explorer, message throughput, error rates, auth success/failure, latency histograms

## Environment Variables (new)

All Go services get:
- `OTEL_EXPORTER_OTLP_ENDPOINT=otel-collector:4317`
- `OTEL_SERVICE_NAME=<service-name>`

## NATS Upgrade Notes

Upgrade `nats:2.10` to `nats:2.12` in docker-compose. Key compatibility considerations:
- JetStream API v2 with strict mode enabled by default in 2.12 (rejects unknown fields). Our persist-worker stream/consumer config uses standard fields only — should be compatible.
- Server names with spaces are rejected (ours has no spaces).
- No breaking changes to auth callout or account-based config.
