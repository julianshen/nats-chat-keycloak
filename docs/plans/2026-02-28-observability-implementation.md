# Observability Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Achieve end-to-end distributed tracing from browser to database, structured JSON logging with trace correlation, comprehensive Grafana dashboards, and alerting.

**Architecture:** Incremental enhancement — layer improvements onto existing OTel infrastructure. Browser gets OTel JS SDK for real spans. Go services get consistent error recording, JSON logging, and standardized attributes. Java KB service completes partial OTel setup. Infrastructure configs get retention, memory limits, and search attributes. Grafana gets service map, trace explorer, and per-service dashboards.

**Tech Stack:** OpenTelemetry (JS SDK, Go SDK, Java SDK), Grafana, Tempo, Loki, Prometheus, nats.ws

---

## Phase 1: Infrastructure Configuration

### Task 1: OTel Collector — memory limiter and resource processor

**Files:**
- Modify: `otel/otel-collector-config.yaml`

**Step 1: Update collector config**

Replace the entire file with:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
      http:
        endpoint: "0.0.0.0:4318"

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 256
  resource:
    attributes:
      - key: deployment.environment
        value: dev
        action: upsert
  batch:
    timeout: 2s
    send_batch_size: 1024

exporters:
  otlphttp/tempo:
    endpoint: http://tempo:4318
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  otlphttp/loki:
    endpoint: http://loki:3100/otlp

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlphttp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlphttp/loki]
```

Key changes: added HTTP receiver on 4318 (for browser OTLP export), memory_limiter processor, resource processor, batch timeout reduced to 2s.

**Step 2: Expose port 4318 in docker-compose.yml**

In the `otel-collector` service, add port 4318:
```yaml
ports:
  - "4317:4317"
  - "4318:4318"
```

**Step 3: Commit**
```bash
git add otel/otel-collector-config.yaml docker-compose.yml
git commit -m "feat(otel): add memory limiter, HTTP receiver, resource processor to collector"
```

---

### Task 2: Tempo — retention, search tags, metrics generator

**Files:**
- Modify: `tempo/tempo.yaml`

**Step 1: Update Tempo config**

Replace the entire file with:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: "0.0.0.0:4318"

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
    wal:
      path: /var/tempo/wal

compactor:
  compaction:
    block_retention: 168h

overrides:
  defaults:
    metrics_generator:
      processors: [service-graphs, span-metrics]

metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://prometheus:9090/api/v1/write
        send_exemplars: true
  processor:
    span_metrics:
      dimensions:
        - chat.room
        - chat.user
        - chat.action
        - service.name
    service_graphs:
      dimensions:
        - chat.room
```

Key changes: 168h (7-day) retention, metrics generator for auto RED metrics, search dimensions for room/user/action.

**Step 2: Add generator WAL volume in docker-compose.yml**

In the `tempo` service volumes, the existing `tempo-data:/var/tempo` already covers the generator WAL path since it's under `/var/tempo`.

**Step 3: Commit**
```bash
git add tempo/tempo.yaml
git commit -m "feat(tempo): add 7-day retention, metrics generator, search dimensions"
```

---

### Task 3: Loki — retention and rate limiting

**Files:**
- Modify: `loki/loki.yaml`

**Step 1: Update Loki config**

Replace the entire file with:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  instance_addr: 127.0.0.1
  path_prefix: /var/loki
  storage:
    filesystem:
      chunks_directory: /var/loki/chunks
      rules_directory: /var/loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  allow_structured_metadata: true
  volume_enabled: true
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 8
  retention_period: 168h

compactor:
  working_directory: /var/loki/compactor
  retention_enabled: true
  delete_request_store: filesystem
```

Key changes: 168h (7-day) retention with compactor, 4MB/s ingestion rate limit.

**Step 2: Commit**
```bash
git add loki/loki.yaml
git commit -m "feat(loki): add 7-day retention, rate limiting, compactor"
```

---

### Task 4: Prometheus — alerting rules

**Files:**
- Create: `prometheus/alert-rules.yaml`
- Modify: `prometheus/prometheus.yaml`

**Step 1: Create alert rules file**

```yaml
groups:
  - name: service_health
    interval: 30s
    rules:
      - alert: ServiceDown
        expr: up == 0 or absent(up{job=~".+"})
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Service {{ $labels.job }} is down"

  - name: error_rates
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: |
          (
            sum by (service_name) (rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))
            /
            sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))
          ) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.service_name }} error rate above 5%"

      - alert: PersistWorkerErrors
        expr: increase(messages_persist_errors_total[5m]) > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Persist worker is failing to write messages"

      - alert: AuthRejectionSpike
        expr: |
          (
            sum(rate(auth_requests_total{result="rejected"}[5m]))
            /
            sum(rate(auth_requests_total[5m]))
          ) > 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Auth rejection rate above 20%"

  - name: latency
    interval: 30s
    rules:
      - alert: SlowRequests
        expr: |
          histogram_quantile(0.95,
            sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m]))
          ) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.service_name }} P95 latency above 2s"

      - alert: HighFanoutLatency
        expr: histogram_quantile(0.95, sum by (le) (rate(fanout_duration_seconds_bucket[5m]))) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Fanout P95 latency above 500ms"
```

**Step 2: Update Prometheus config**

Replace `prometheus/prometheus.yaml` with:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alert-rules.yaml
```

**Step 3: Mount alert rules in docker-compose.yml**

In the `prometheus` service, add to volumes:
```yaml
- ./prometheus/alert-rules.yaml:/etc/prometheus/alert-rules.yaml:ro
```

**Step 4: Commit**
```bash
git add prometheus/alert-rules.yaml prometheus/prometheus.yaml docker-compose.yml
git commit -m "feat(prometheus): add alerting rules for errors, latency, service health"
```

---

## Phase 2: Go OTel Helper Improvements

### Task 5: Switch slog to JSON format

**Files:**
- Modify: `pkg/otelhelper/otel.go`

**Step 1: Change slog handler from Text to JSON**

In `pkg/otelhelper/otel.go`, find the line (near line 141):
```go
slog.SetDefault(slog.New(&tracingHandler{inner: slog.NewTextHandler(os.Stderr, nil)}))
```

Replace with:
```go
slog.SetDefault(slog.New(&tracingHandler{inner: slog.NewJSONHandler(os.Stderr, nil)}))
```

This single change makes ALL Go services emit JSON logs with auto-injected `trace_id` and `span_id` fields. Loki can parse these as structured fields for querying.

**Step 2: Verify no other slog handler overrides exist**

Check that no Go service overrides the default slog handler after calling `otelhelper.Init()`. (Research confirms none do.)

**Step 3: Commit**
```bash
git add pkg/otelhelper/otel.go
git commit -m "feat(otelhelper): switch slog to JSON format for Loki structured logging"
```

---

### Task 6: Add standardized histogram buckets to otelhelper

**Files:**
- Modify: `pkg/otelhelper/otel.go`

**Step 1: Add histogram bucket constants**

Near the top of `otel.go`, add a shared bucket definition:

```go
// NATSLatencyBuckets are histogram boundaries tuned for NATS messaging latencies.
var NATSLatencyBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5}
```

**Step 2: Export a helper for creating histograms**

```go
// NewDurationHistogram creates a Float64Histogram with NATS-tuned boundaries.
func NewDurationHistogram(meter metric.Meter, name, description string) (metric.Float64Histogram, error) {
	return meter.Float64Histogram(name,
		metric.WithDescription(description),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(NATSLatencyBuckets...),
	)
}
```

**Step 3: Commit**
```bash
git add pkg/otelhelper/otel.go
git commit -m "feat(otelhelper): add standardized histogram buckets for NATS latencies"
```

---

## Phase 3: Go Service Error Recording & Span Events

### Task 7: Fix fanout-service error recording and add span events

**Files:**
- Modify: `fanout-service/main.go`

**Step 1: Add error recording to all span creation points**

Research shows 5 span creation points with 0% error recording. For each span, after any error path, add:

```go
span.RecordError(err)
span.SetStatus(codes.Error, err.Error())
```

Locations to fix (from research):
- Line ~738 area: "ingest user message" span — add error recording for lines 752-759
- Line ~808 area: "fanout notify" span — add error recording for line 836
- Line ~903 area: "msg.get" span — add error recording for line 924
- All `TracedPublish` call sites that don't check errors

**Step 2: Add span events for cache operations**

After cache lookups in the fanout handler, add:
```go
span.AddEvent("cache_hit", trace.WithAttributes(attribute.String("chat.room", room)))
// or
span.AddEvent("cache_miss", trace.WithAttributes(attribute.String("chat.room", room)))
```

**Step 3: Add standardized attributes**

Ensure all spans set:
```go
span.SetAttributes(
    attribute.String("chat.room", room),
    attribute.String("chat.user", user),
    attribute.String("chat.action", action),
)
```

**Step 4: Update duration histogram to use shared buckets**

Replace the existing histogram creation with:
```go
fanoutDuration, _ = otelhelper.NewDurationHistogram(meter, "fanout_duration_seconds", "Fanout processing duration")
```

**Step 5: Convert slog.Info/Error to slog.InfoContext/ErrorContext**

Replace bare `slog.Info(...)` calls with `slog.InfoContext(ctx, ...)` where a span context is available, so logs are automatically correlated with traces.

**Step 6: Commit**
```bash
git add fanout-service/main.go
git commit -m "feat(fanout): add error recording, span events, standardized attributes, JSON logging"
```

---

### Task 8: Fix room-service error recording

**Files:**
- Modify: `room-service/main.go`

**Step 1: Add error recording to all 9 span creation points**

Research shows 9 spans with ~11% error recording. Fix all these locations:
- Line ~455: "room join" — add error recording for KV create failures
- Line ~499: "room leave" — add error recording for KV delete failures
- Line ~530: "room members query" — add error recording
- Line ~567: "room.create" — add error recording for DB failures (line 630)
- Line ~656: "room.list" — add error recording for query failures (lines 717, 728)
- Line ~703: "room.info" — add error recording
- Line ~756: "room.invite" — add error recording for DB failures (lines 783, 790)
- Line ~808: "room.kick" — add error recording for DB failures (lines 844, 851)
- Line ~869: "room.depart" — add error recording for DB failures (lines 897, 912, 925)

For each:
```go
if err != nil {
    span.RecordError(err)
    span.SetStatus(codes.Error, err.Error())
    // existing error handling...
}
```

**Step 2: Add standardized attributes and span events**

```go
span.SetAttributes(attribute.String("chat.room", room), attribute.String("chat.user", userId))
span.AddEvent("kv_create", trace.WithAttributes(attribute.String("chat.room", room)))
span.AddEvent("access_denied", trace.WithAttributes(attribute.String("chat.room", room)))
```

**Step 3: Update histogram + convert slog calls**

Same pattern as Task 7 — use `otelhelper.NewDurationHistogram()` and convert to `slog.InfoContext(ctx, ...)`.

**Step 4: Commit**
```bash
git add room-service/main.go
git commit -m "feat(room): add error recording, span events, standardized attributes"
```

---

### Task 9: Fix poll-service error recording

**Files:**
- Modify: `poll-service/main.go`

**Step 1: Add missing error recording**

Research shows 1 span with 20% error recording (only create handler records errors). Fix:
- Line ~251: list query failure — add `span.RecordError(err)`
- Line ~298: vote failure — add `span.RecordError(err)`
- Line ~312: results failure — add `span.RecordError(err)`
- Line ~340: close failure — add `span.RecordError(err)`

**Step 2: Add standardized attributes**

```go
span.SetAttributes(
    attribute.String("chat.room", room),
    attribute.String("chat.action", action),
)
```

**Step 3: Update histogram + slog context**

Same pattern as Tasks 7-8.

**Step 4: Commit**
```bash
git add poll-service/main.go
git commit -m "feat(poll): add error recording, standardized attributes"
```

---

### Task 10: Enhance remaining Go services

**Files:**
- Modify: `presence-service/main.go`
- Modify: `persist-worker/main.go`
- Modify: `history-service/main.go`
- Modify: `sticker-service/main.go`
- Modify: `app-registry-service/main.go`
- Modify: `user-search-service/main.go`
- Modify: `translation-service/main.go`

These services already have good error recording (research shows 100% for most). Changes needed:

**Step 1: Add standardized attributes to all spans**

For each service, ensure spans include `chat.room`, `chat.user`, `chat.action` where applicable.

**Step 2: Add span events for key operations**

- presence-service: `heartbeat_received`, `connection_expired`, `status_changed`
- persist-worker: `message_persisted` (on successful write)

**Step 3: Update histograms to use shared buckets**

Replace histogram creation in each service with `otelhelper.NewDurationHistogram()`.

**Step 4: Convert slog calls to context-aware versions**

Replace `slog.Info(...)` with `slog.InfoContext(ctx, ...)` where span context is available.

**Step 5: Commit**
```bash
git add presence-service/ persist-worker/ history-service/ sticker-service/ app-registry-service/ user-search-service/ translation-service/
git commit -m "feat(services): standardize attributes, span events, histogram buckets, context logging"
```

---

### Task 11: Add HTTP tracing to auth-service JWKS client

**Files:**
- Modify: `auth-service/keycloak.go`
- Modify: `auth-service/go.mod` (if needed)

**Step 1: Check if `otelhttp` is already a dependency**

The auth-service uses `keyfunc/v2` which manages its own HTTP client internally. Since keyfunc doesn't expose the HTTP transport for wrapping, we have two options:

Option A: Add a span event on JWKS refresh (simpler — `keyfunc` emits logs on refresh which we can track via slog).

Option B: Fork the keyfunc client config to pass a custom `http.Client` with `otelhttp.NewTransport()`.

**Recommended: Option A** — Add a span event in the JWKS init/refresh area. The keyfunc library handles its own HTTP calls, and wrapping its transport adds fragility.

**Step 2: Add `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` to auth-service go.mod**

```bash
cd auth-service && go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

**Step 3: If keyfunc supports custom HTTP client, wrap it**

In `keycloak.go`, check if `keyfunc.Get()` or `keyfunc.Options` accepts an `http.Client`. If yes:
```go
httpClient := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}
// pass to keyfunc Options
```

If not, skip and rely on slog context logging for JWKS activity.

**Step 4: Commit**
```bash
git add auth-service/
git commit -m "feat(auth): add HTTP tracing for JWKS fetches"
```

---

## Phase 4: Java KB Service

### Task 12: Complete KB service OTel setup

**Files:**
- Modify: `apps/kb/service/pom.xml`
- Modify: `apps/kb/service/src/main/java/com/example/kb/OtelConfig.java`
- Modify: `apps/kb/service/src/main/java/com/example/kb/NatsHandler.java`
- Modify: `docker-compose.yml`
- Create: `apps/kb/service/src/main/resources/logback.xml`

Research found that OtelConfig.java and NatsTracing.java already exist as untracked files with partial OTel setup. NatsHandler.java already has span creation. We need to complete the gaps.

**Step 1: Add OTel env vars to docker-compose.yml**

In the `kb-service` service, add:
```yaml
environment:
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
  OTEL_SERVICE_NAME: kb-service
depends_on:
  - nats
  - postgres
  - otel-collector
```

Note: Use port 4318 (HTTP) since OtelConfig.java uses the HTTP exporter.

**Step 2: Add metrics dependencies to pom.xml**

Add after existing OTel dependencies:
```xml
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-sdk-metrics</artifactId>
    <version>1.32.0</version>
</dependency>
```

**Step 3: Add metrics exporter to OtelConfig.java**

In the `openTelemetrySdk()` method, add metrics provider:
```java
SdkMeterProvider meterProvider = SdkMeterProvider.builder()
    .registerMetricReader(
        PeriodicMetricReader.builder(
            OtlpHttpMetricExporter.builder()
                .setEndpoint(endpoint + "/v1/metrics")
                .build()
        ).build()
    )
    .setResource(resource)
    .build();
```

Add to the SDK builder:
```java
.setMeterProvider(meterProvider)
```

**Step 4: Fix publishPresence() trace injection**

In `NatsHandler.java`, line ~278, the `publishPresence()` method publishes without trace context. Fix:
```java
private void publishPresence(String room, String pageId, Set<String> editors) {
    // ... existing JSON building ...
    io.nats.client.impl.NatsMessage.Builder msgBuilder =
        io.nats.client.impl.NatsMessage.builder()
            .subject("app.kb." + room + ".presence")
            .data(json.getBytes());

    NatsTracing.injectContext(Context.current(), msgBuilder);
    nc.publish(msgBuilder.build());
}
```

**Step 5: Create logback.xml for structured JSON logging**

Create `apps/kb/service/src/main/resources/logback.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="ch.qos.logback.classic.encoder.JsonEncoder"/>
    </appender>
    <root level="INFO">
        <appender-ref ref="STDOUT"/>
    </root>
</configuration>
```

Note: The OTel Java agent auto-injects trace_id/span_id into MDC. The JSON encoder will include these fields.

**Step 6: Commit**
```bash
git add apps/kb/service/ docker-compose.yml
git commit -m "feat(kb): complete OTel setup with metrics, trace injection, JSON logging"
```

---

## Phase 5: Browser OTel JS SDK

### Task 13: Add OpenTelemetry JS SDK to web app

**Files:**
- Modify: `web/package.json`
- Create: `web/src/lib/otel.ts`
- Modify: `web/src/utils/tracing.ts`
- Modify: `web/nginx.conf`

**Step 1: Install OTel dependencies**

```bash
cd web && npm install \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-web \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opentelemetry/context-zone
```

**Step 2: Create `web/src/lib/otel.ts`**

```typescript
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-web';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const endpoint = (window as any).__env__?.VITE_OTLP_ENDPOINT
  || import.meta.env.VITE_OTLP_ENDPOINT
  || 'http://localhost:4318';

const provider = new WebTracerProvider({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'web-frontend',
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })
    ),
  ],
});

provider.register({
  contextManager: new ZoneContextManager(),
  propagator: new W3CTraceContextPropagator(),
});

export const tracer = trace.getTracer('nats-chat-web', '1.0.0');
export { context, propagation, SpanKind, SpanStatusCode };
```

**Step 3: Refactor `web/src/utils/tracing.ts`**

Replace the homegrown tracing with real OTel spans:

```typescript
import { tracer, context, propagation, SpanKind, SpanStatusCode } from '../lib/otel';
import { headers as natsHeaders, type MsgHdrs } from 'nats.ws';

class NatsHeaderCarrier {
  private hdrs: MsgHdrs;
  constructor(hdrs: MsgHdrs) { this.hdrs = hdrs; }
  get(key: string): string | undefined { return this.hdrs.get(key); }
  set(key: string, value: string): void { this.hdrs.set(key, value); }
  keys(): string[] { return this.hdrs.keys(); }
}

// Creates a PRODUCER span and returns NATS headers with injected trace context
export function tracedHeaders(spanName?: string): { headers: MsgHdrs; traceId: string } {
  const hdrs = natsHeaders();
  const span = tracer.startSpan(spanName || 'nats.publish', { kind: SpanKind.PRODUCER });
  const ctx = trace.setSpan(context.active(), span);
  propagation.inject(ctx, new NatsHeaderCarrier(hdrs));
  const traceId = span.spanContext().traceId;
  span.end();
  return { headers: hdrs, traceId };
}

// Wraps a user action in a parent span, returns context for child spans
export function startActionSpan(name: string): { ctx: any; end: (error?: Error) => void } {
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL });
  const ctx = trace.setSpan(context.active(), span);
  return {
    ctx,
    end: (error?: Error) => {
      if (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      span.end();
    },
  };
}

// Creates traced headers within an existing action span context
export function tracedHeadersWithContext(ctx: any, spanName: string): { headers: MsgHdrs; traceId: string } {
  const hdrs = natsHeaders();
  const span = tracer.startSpan(spanName, { kind: SpanKind.PRODUCER }, ctx);
  const spanCtx = trace.setSpan(ctx, span);
  propagation.inject(spanCtx, new NatsHeaderCarrier(hdrs));
  const traceId = span.spanContext().traceId;
  span.end();
  return { headers: hdrs, traceId };
}

// Structured console logging (kept for backward compat)
export function trace_log(level: 'debug' | 'info' | 'warn' | 'error', tag: string, msg: string, fields?: Record<string, any>) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const fieldStr = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  fn(`[${tag}] ${msg}${fieldStr}`);
}
```

Note: The existing `tracedHeaders()` signature is preserved so all 14+ call sites in MessageProvider continue working without changes. The difference is now it creates real OTel spans.

**Step 4: Add OTLP proxy route to nginx.conf**

In `web/nginx.conf`, add before the closing `}` of the server block:
```nginx
location /otlp/ {
    proxy_pass http://otel-collector:4318/;
    proxy_set_header Host $host;
}
```

**Step 5: Add env var to docker-compose.yml web service**

In the `web` service environment (if it exists), or to `web/env.js` for K8s:
The browser needs to know where to send OTLP. For Docker Compose dev mode, the browser hits `http://localhost:4318` directly (already exposed in Task 1). For K8s, it uses the nginx proxy at `/otlp/`.

**Step 6: Commit**
```bash
git add web/
git commit -m "feat(web): add OpenTelemetry JS SDK with real browser spans"
```

---

### Task 14: Wrap key user actions in parent spans

**Files:**
- Modify: `web/src/providers/MessageProvider.tsx`
- Modify: `web/src/components/ChatRoom.tsx`

**Step 1: Wrap joinRoom in a parent span**

In MessageProvider.tsx, in the `joinRoom` function, wrap the sequence of operations:

```typescript
import { startActionSpan, tracedHeadersWithContext } from '../utils/tracing';

const joinRoom = async (room: string) => {
  const action = startActionSpan('join_room');
  try {
    // existing room.join publish (use tracedHeadersWithContext(action.ctx, 'room.join'))
    // existing presence.room request
    // existing chat.history request
    action.end();
  } catch (err) {
    action.end(err as Error);
  }
};
```

**Step 2: Wrap message send in ChatRoom.tsx**

In `handleSend()`:
```typescript
const action = startActionSpan('send_message');
try {
  // existing nc.publish call (use tracedHeadersWithContext(action.ctx, 'chat.publish'))
  action.end();
} catch (err) {
  action.end(err as Error);
}
```

**Step 3: Wrap other key actions**

Apply the same pattern to:
- `handleEdit()` — `startActionSpan('edit_message')`
- `handleDelete()` — `startActionSpan('delete_message')`
- `handleTranslate()` — `startActionSpan('translate_message')`
- `handleReact()` — `startActionSpan('react_message')`
- Presence heartbeat — wrap the periodic heartbeat in a span (low priority, can skip)

**Step 4: Commit**
```bash
git add web/src/
git commit -m "feat(web): wrap user actions in parent spans for end-to-end tracing"
```

---

## Phase 6: Grafana Dashboards

### Task 15: Create overview dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-overview.json`

**Step 1: Create the overview dashboard JSON**

Build a Grafana dashboard with these panels:

1. **Service Map** (Node Graph panel)
   - Datasource: Tempo
   - Query type: Service Map (uses `traces_service_graph_request_total` from Tempo metrics generator)

2. **Trace Explorer** (Table panel)
   - Datasource: Tempo
   - TraceQL query: `{}`
   - Filterable by: service.name, chat.room, chat.user, status

3. **Request Rate** (Time Series panel)
   - Datasource: Prometheus
   - Query: `sum by (service_name) (rate(traces_spanmetrics_calls_total[5m]))`

4. **Error Rate** (Time Series panel)
   - Datasource: Prometheus
   - Query: `sum by (service_name) (rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))`

5. **P95 Latency** (Time Series panel)
   - Datasource: Prometheus
   - Query: `histogram_quantile(0.95, sum by (service_name, le) (rate(traces_spanmetrics_duration_seconds_bucket[5m])))`

6. **Recent Errors** (Logs panel)
   - Datasource: Loki
   - Query: `{} | json | level="ERROR" or level="error"`

7. **Alert Status** (Alert list panel)
   - Shows firing/pending alerts from Prometheus

The JSON will be a standard Grafana dashboard export. Generate it programmatically or use Grafana's JSON model format.

**Step 2: Commit**
```bash
git add grafana/provisioning/dashboards/nats-chat-overview.json
git commit -m "feat(grafana): add service overview dashboard with service map, traces, alerts"
```

---

### Task 16: Create auth service dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-auth.json`

**Panels:**
1. Auth Requests/sec — `sum by (result) (rate(auth_requests_total[5m]))` stacked by result
2. Auth Latency — `histogram_quantile(0.5, ...) / 0.95 / 0.99` on `auth_request_duration_seconds`
3. Auth Type Distribution — `sum by (auth_type) (rate(auth_requests_total[5m]))` (browser vs service)
4. Rejection Rate — `rate(auth_requests_total{result="rejected"}[5m]) / rate(auth_requests_total[5m])`
5. Recent Auth Traces — Tempo TraceQL `{service.name="auth-service"}`
6. Auth Logs — Loki `{service_name="auth-service"} | json`

**Commit:**
```bash
git add grafana/provisioning/dashboards/nats-chat-auth.json
git commit -m "feat(grafana): add auth service dashboard"
```

---

### Task 17: Create message pipeline dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-messages.json`

**Panels:**
1. Fanout Throughput — `rate(fanout_messages_total[5m])`
2. Fanout Latency P50/P95/P99 — `histogram_quantile(...)` on `fanout_duration_seconds`
3. Cache Hit/Miss Rate — `rate(fanout_cache_misses_total[5m])`
4. Persist Worker Write Rate — `rate(messages_persisted_total[5m])`
5. Persist Errors — `rate(messages_persist_errors_total[5m])`
6. History Query Latency — `histogram_quantile(...)` on `history_request_duration_seconds`
7. End-to-End Message Trace — Tempo TraceQL `{span.chat.action="send"}`
8. Pipeline Logs — Loki `{service_name=~"fanout-service|persist-worker|history-service"} | json`

**Commit:**
```bash
git add grafana/provisioning/dashboards/nats-chat-messages.json
git commit -m "feat(grafana): add message pipeline dashboard"
```

---

### Task 18: Create rooms & presence dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-rooms.json`

**Panels:**
1. Room Joins/Leaves — `rate(room_joins_total[5m])` / `rate(room_leaves_total[5m])`
2. Active Rooms — `room_active_rooms` gauge
3. Room Operation Latency — `histogram_quantile(...)` on `room_request_duration_seconds`
4. Presence Heartbeats — `rate(presence_heartbeats_total[5m])`
5. Presence Expirations — `rate(presence_expirations_total[5m])`
6. Presence Query Latency — `histogram_quantile(...)` on `presence_query_duration_seconds`
7. Room/Presence Traces — Tempo TraceQL `{service.name=~"room-service|presence-service"}`
8. Logs — Loki `{service_name=~"room-service|presence-service"} | json`

**Commit:**
```bash
git add grafana/provisioning/dashboards/nats-chat-rooms.json
git commit -m "feat(grafana): add rooms & presence dashboard"
```

---

### Task 19: Create apps dashboard

**Files:**
- Create: `grafana/provisioning/dashboards/nats-chat-apps.json`

**Panels:**
1. App Registry Requests — `rate(app_registry_requests_total[5m])`
2. Poll Operations — `rate(poll_requests_total[5m])`
3. KB Operations — from Tempo span metrics (kb-service)
4. App Latency — `histogram_quantile(...)` on `app_registry_request_duration_seconds` / `poll_request_duration_seconds`
5. App Traces — Tempo TraceQL `{service.name=~"app-registry-service|poll-service|kb-service"}`
6. App Logs — Loki `{service_name=~"app-registry-service|poll-service|kb-service"} | json`

**Commit:**
```bash
git add grafana/provisioning/dashboards/nats-chat-apps.json
git commit -m "feat(grafana): add apps dashboard"
```

---

## Phase 7: Final Integration

### Task 20: Update Grafana datasource cross-linking

**Files:**
- Modify: `grafana/provisioning/datasources/datasources.yaml`

**Step 1: Update Loki derived fields regex for JSON logs**

Since Go services now emit JSON, the trace_id field is a JSON key. Update the derived fields regex:

Current (designed for text format):
```yaml
derivedFields:
  - name: trace_id
    matcherRegex: '"trace_id":"(\w+)"'
    url: "$${__value.raw}"
    datasourceUid: tempo
```

The JSON format emits `"trace_id":"abc123"` which the current regex already handles. Verify this works.

**Step 2: Commit**
```bash
git add grafana/provisioning/datasources/datasources.yaml
git commit -m "feat(grafana): verify datasource cross-linking for JSON log format"
```

---

### Task 21: Verify end-to-end and final commit

**Step 1: Rebuild and start all services**
```bash
docker compose down
docker compose up -d --build
```

**Step 2: Wait for services to start, then test**

1. Open browser at http://localhost:3000
2. Login as alice/alice123
3. Send a message in #general
4. Open Grafana at http://localhost:3001
5. Go to Explore → Tempo → search for recent traces
6. Verify you see: browser span → fanout span → persist span → DB span (linked)
7. Click a span → verify logs panel shows correlated Loki logs
8. Go to Dashboards → Service Overview → verify service map, error rates, latency panels
9. Go to per-service dashboards → verify metrics populate

**Step 3: Fix any issues found during verification**

**Step 4: Final commit**
```bash
git add -A
git commit -m "feat: complete end-to-end observability with tracing, logging, dashboards, alerts"
```
