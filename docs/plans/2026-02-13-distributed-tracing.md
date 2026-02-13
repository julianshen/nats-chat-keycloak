# Distributed Tracing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add full observability (traces, metrics, logs) using OpenTelemetry, Grafana Tempo, Prometheus, Loki, and a central OTel Collector.

**Architecture:** All 3 Go services export telemetry via OTLP/gRPC to a central OpenTelemetry Collector, which routes traces to Tempo, metrics to Prometheus, and logs to Loki. Grafana on port 3001 queries all three. NATS upgraded from 2.10 to 2.12. A shared `pkg/otelhelper` Go module provides OTel initialization and NATS trace context propagation helpers.

**Tech Stack:** OpenTelemetry Go SDK, OTel Collector Contrib, Grafana Tempo, Prometheus, Loki, Grafana, `otelsql`, `slog` + OTel bridge

---

### Task 1: Observability Infrastructure — Config Files

Create configuration files for OTel Collector, Tempo, Prometheus, Loki, and Grafana provisioning.

**Files:**
- Create: `otel/otel-collector-config.yaml`
- Create: `tempo/tempo.yaml`
- Create: `prometheus/prometheus.yaml`
- Create: `loki/loki.yaml`
- Create: `grafana/provisioning/datasources/datasources.yaml`

**Step 1: Create OTel Collector config**

Create `otel/otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024

exporters:
  otlphttp/tempo:
    endpoint: "http://tempo:4318"
    tls:
      insecure: true

  prometheusremotewrite:
    endpoint: "http://prometheus:9090/api/v1/write"
    tls:
      insecure: true

  loki:
    endpoint: "http://loki:3100/loki/api/v1/push"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/tempo]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [loki]
```

**Step 2: Create Tempo config**

Create `tempo/tempo.yaml`:

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

metrics_generator:
  storage:
    path: /var/tempo/metrics
  traces_storage:
    path: /var/tempo/traces
```

**Step 3: Create Prometheus config**

Create `prometheus/prometheus.yaml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

remote_write: []

features:
  remote-write-receiver: true
```

Note: Prometheus receives metrics via remote write from OTel Collector, not scraping. The `--web.enable-remote-write-receiver` flag is set in docker-compose command.

**Step 4: Create Loki config**

Create `loki/loki.yaml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
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
```

**Step 5: Create Grafana datasource provisioning**

Create `grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: true
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceID: true
      tracesToMetrics:
        datasourceUid: prometheus
      serviceMap:
        datasourceUid: prometheus

  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://prometheus:9090

  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"(\w+)"'
          name: TraceID
          url: "$${__value.raw}"
```

**Step 6: Commit**

```bash
git add otel/ tempo/ prometheus/ loki/ grafana/
git commit -m "feat: add observability infrastructure config files"
```

---

### Task 2: Observability Infrastructure — Docker Compose

Add all observability containers and upgrade NATS to 2.12.

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Update docker-compose.yml**

Change the NATS image from `nats:2.10` to `nats:2.12` (line 21).

Add the following services after the existing `web` service:

```yaml
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otel/config.yaml"]
    volumes:
      - ./otel/otel-collector-config.yaml:/etc/otel/config.yaml:ro
    ports:
      - "4317:4317"

  tempo:
    image: grafana/tempo:latest
    command: ["-config.file=/etc/tempo/tempo.yaml"]
    volumes:
      - ./tempo/tempo.yaml:/etc/tempo/tempo.yaml:ro
      - tempo-data:/var/tempo

  prometheus:
    image: prom/prometheus:latest
    command:
      - "--config.file=/etc/prometheus/prometheus.yaml"
      - "--web.enable-remote-write-receiver"
      - "--storage.tsdb.path=/prometheus"
    volumes:
      - ./prometheus/prometheus.yaml:/etc/prometheus/prometheus.yaml:ro
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"

  loki:
    image: grafana/loki:latest
    command: ["-config.file=/etc/loki/loki.yaml"]
    volumes:
      - ./loki/loki.yaml:/etc/loki/loki.yaml:ro
      - loki-data:/var/loki

  grafana:
    image: grafana/grafana:latest
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
    ports:
      - "3001:3000"
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - grafana-data:/var/lib/grafana
    depends_on:
      - tempo
      - prometheus
      - loki
```

Add volumes to the volumes section:

```yaml
volumes:
  nats-data:
  postgres-data:
  tempo-data:
  prometheus-data:
  loki-data:
  grafana-data:
```

Add `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` env vars to each Go service:

For `auth-service`, add:
```yaml
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
      OTEL_SERVICE_NAME: auth-service
```

For `persist-worker`, add:
```yaml
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
      OTEL_SERVICE_NAME: persist-worker
```

For `history-service`, add:
```yaml
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
      OTEL_SERVICE_NAME: history-service
```

Also update each Go service's `build` directive to use the root context (needed for shared `pkg/` access):

```yaml
  auth-service:
    build:
      context: .
      dockerfile: auth-service/Dockerfile
```

```yaml
  persist-worker:
    build:
      context: .
      dockerfile: persist-worker/Dockerfile
```

```yaml
  history-service:
    build:
      context: .
      dockerfile: history-service/Dockerfile
```

**Step 2: Update each Dockerfile to copy pkg/ directory**

Each Go service Dockerfile needs to copy the shared `pkg/otelhelper` module. Update the builder stage.

For `auth-service/Dockerfile`:

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY auth-service/go.mod auth-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY auth-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /auth-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /auth-service /auth-service

ENTRYPOINT ["/auth-service"]
```

For `persist-worker/Dockerfile`:

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY persist-worker/go.mod persist-worker/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY persist-worker/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /persist-worker .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /persist-worker /persist-worker

ENTRYPOINT ["/persist-worker"]
```

For `history-service/Dockerfile`:

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY history-service/go.mod history-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY history-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /history-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /history-service /history-service

ENTRYPOINT ["/history-service"]
```

**Step 3: Verify infrastructure starts**

```bash
docker compose up -d --build otel-collector tempo prometheus loki grafana nats
docker compose ps
```

Expected: All 6 containers "Up". Grafana accessible at `http://localhost:3001`.

**Step 4: Commit**

```bash
git add docker-compose.yml auth-service/Dockerfile persist-worker/Dockerfile history-service/Dockerfile
git commit -m "feat: add observability stack to docker-compose, upgrade NATS to 2.12"
```

---

### Task 3: Shared OTel Helper Package

Create the shared Go module with OTel initialization and NATS trace context propagation helpers.

**Files:**
- Create: `pkg/otelhelper/go.mod`
- Create: `pkg/otelhelper/otel.go`
- Create: `pkg/otelhelper/nats.go`

**Step 1: Create go.mod**

Create `pkg/otelhelper/go.mod`:

```
module github.com/example/nats-chat-otelhelper

go 1.22

require (
	github.com/nats-io/nats.go v1.38.0
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc v0.10.0
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.34.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.34.0
	go.opentelemetry.io/otel/log v0.10.0
	go.opentelemetry.io/otel/metric v1.34.0
	go.opentelemetry.io/otel/sdk v1.34.0
	go.opentelemetry.io/otel/sdk/log v0.10.0
	go.opentelemetry.io/otel/sdk/metric v1.34.0
	go.opentelemetry.io/otel/trace v1.34.0
)
```

Then run `go mod tidy` to resolve transitive deps.

**Step 2: Create otel.go — OTel initialization**

Create `pkg/otelhelper/otel.go`:

```go
package otelhelper

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Shutdown is a function to cleanly shut down OTel providers.
type Shutdown func(context.Context) error

// Init initializes OpenTelemetry with OTLP/gRPC exporters for traces, metrics,
// and logs. It reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME from
// environment variables. Returns a shutdown function that must be called on exit.
func Init(ctx context.Context) (Shutdown, error) {
	serviceName := os.Getenv("OTEL_SERVICE_NAME")
	if serviceName == "" {
		serviceName = "unknown-service"
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String(serviceName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	// Trace exporter
	traceExporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create trace exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)

	// Metric exporter
	metricExporter, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create metric exporter: %w", err)
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter)),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	// Log exporter
	logExporter, err := otlploggrpc.New(ctx,
		otlploggrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create log exporter: %w", err)
	}

	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(lp)

	// Set propagator (W3C Trace Context)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	// Return combined shutdown
	shutdown := func(ctx context.Context) error {
		var errs []error
		if err := tp.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		if err := mp.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		if err := lp.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		if len(errs) > 0 {
			return fmt.Errorf("shutdown errors: %v", errs)
		}
		return nil
	}

	slog.Info("OpenTelemetry initialized", "service", serviceName)

	return shutdown, nil
}
```

**Step 3: Create nats.go — NATS trace context helpers**

Create `pkg/otelhelper/nats.go`:

```go
package otelhelper

import (
	"context"

	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// NatsHeaderCarrier adapts nats.Header to propagation.TextMapCarrier.
type NatsHeaderCarrier struct {
	Header nats.Header
}

func (c *NatsHeaderCarrier) Get(key string) string {
	return c.Header.Get(key)
}

func (c *NatsHeaderCarrier) Set(key, value string) {
	c.Header.Set(key, value)
}

func (c *NatsHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c.Header))
	for k := range c.Header {
		keys = append(keys, k)
	}
	return keys
}

var tracer = otel.Tracer("nats-chat")

// InjectContext creates a nats.Header with trace context injected.
func InjectContext(ctx context.Context) nats.Header {
	h := nats.Header{}
	carrier := &NatsHeaderCarrier{Header: h}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return h
}

// ExtractContext extracts trace context from a NATS message header.
func ExtractContext(ctx context.Context, header nats.Header) context.Context {
	if header == nil {
		return ctx
	}
	carrier := &NatsHeaderCarrier{Header: header}
	return otel.GetTextMapPropagator().Extract(ctx, carrier)
}

// TracedPublish publishes a NATS message with trace context propagated in headers.
// Creates a PRODUCER span.
func TracedPublish(ctx context.Context, nc *nats.Conn, subject string, data []byte) error {
	ctx, span := tracer.Start(ctx, subject+" publish",
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "nats"),
			attribute.String("messaging.destination.name", subject),
			attribute.Int("messaging.message.payload_size_bytes", len(data)),
		),
	)
	defer span.End()

	msg := &nats.Msg{
		Subject: subject,
		Data:    data,
		Header:  InjectContext(ctx),
	}
	return nc.PublishMsg(msg)
}

// TracedRequest sends a NATS request with trace context propagated.
// Creates a CLIENT span.
func TracedRequest(ctx context.Context, nc *nats.Conn, subject string, data []byte) (*nats.Msg, error) {
	ctx, span := tracer.Start(ctx, subject+" request",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("messaging.system", "nats"),
			attribute.String("messaging.destination.name", subject),
			attribute.Int("messaging.message.payload_size_bytes", len(data)),
		),
	)
	defer span.End()

	msg := &nats.Msg{
		Subject: subject,
		Data:    data,
		Header:  InjectContext(ctx),
	}
	reply, err := nc.RequestMsg(msg, nats.DefaultTimeout)
	if err != nil {
		span.RecordError(err)
		return nil, err
	}
	span.SetAttributes(attribute.Int("messaging.message.response_size_bytes", len(reply.Data)))
	return reply, nil
}

// StartConsumerSpan extracts trace context from a NATS message and starts a CONSUMER span.
// Returns the new context and span. Caller must call span.End().
func StartConsumerSpan(ctx context.Context, msg *nats.Msg, operationName string) (context.Context, trace.Span) {
	ctx = ExtractContext(ctx, msg.Header)
	ctx, span := tracer.Start(ctx, operationName,
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "nats"),
			attribute.String("messaging.destination.name", msg.Subject),
			attribute.Int("messaging.message.payload_size_bytes", len(msg.Data)),
		),
	)
	return ctx, span
}

// StartServerSpan extracts trace context from a NATS message and starts a SERVER span
// (for request/reply responders). Returns the new context and span. Caller must call span.End().
func StartServerSpan(ctx context.Context, msg *nats.Msg, operationName string) (context.Context, trace.Span) {
	ctx = ExtractContext(ctx, msg.Header)
	ctx, span := tracer.Start(ctx, operationName,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("messaging.system", "nats"),
			attribute.String("messaging.destination.name", msg.Subject),
			attribute.Int("messaging.message.payload_size_bytes", len(msg.Data)),
		),
	)
	return ctx, span
}
```

**Step 4: Run go mod tidy**

```bash
cd pkg/otelhelper && go mod tidy
```

**Step 5: Verify it compiles**

```bash
cd pkg/otelhelper && go build ./...
```

Expected: BUILD OK

**Step 6: Commit**

```bash
git add pkg/
git commit -m "feat: add shared OTel helper package with NATS trace propagation"
```

---

### Task 4: Instrument persist-worker

Add OTel instrumentation to the persist-worker service.

**Files:**
- Modify: `persist-worker/go.mod`
- Modify: `persist-worker/main.go`

**Step 1: Update go.mod**

Add the otelhelper dependency and OTel packages to `persist-worker/go.mod`:

```
require (
	github.com/XSAM/otelsql v0.35.0
	github.com/example/nats-chat-otelhelper v0.0.0
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/metric v1.34.0
	go.opentelemetry.io/otel/trace v1.34.0
)

replace github.com/example/nats-chat-otelhelper => ../pkg/otelhelper
```

Then run `cd persist-worker && go mod tidy`.

**Step 2: Update main.go with OTel instrumentation**

Replace the entire `persist-worker/main.go` with the instrumented version. Key changes:
- Import `otelhelper`, `otelsql`, `slog`, OTel metric packages
- Call `otelhelper.Init(ctx)` at startup, defer shutdown
- Wrap `sql.Open` with `otelsql.Open` for PostgreSQL tracing
- In the consume callback: call `otelhelper.StartConsumerSpan` to create a span from the JetStream message headers
- Add metrics: `messages_persisted_total` counter, `messages_persist_errors_total` counter
- Replace `log.Printf` with `slog.Info`/`slog.Error`/`slog.Warn`

```go
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type ChatMessage struct {
	User      string `json:"user"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
	Room      string `json:"room"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx := context.Background()

	// Initialize OpenTelemetry
	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("persist-worker")
	persistedCounter, _ := meter.Int64Counter("messages_persisted_total",
	)
	errorCounter, _ := meter.Int64Counter("messages_persist_errors_total",
	)

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "persist-worker")
	natsPass := envOrDefault("NATS_PASS", "persist-worker-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	slog.Info("Starting Persist Worker", "nats_url", natsURL)

	// Connect to PostgreSQL with otelsql for automatic query tracing
	db, err := otelsql.Open("postgres", dbURL,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL),
	)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	for attempt := 1; attempt <= 30; attempt++ {
		err = db.Ping()
		if err == nil {
			break
		}
		slog.Info("Waiting for PostgreSQL", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to PostgreSQL", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	slog.Info("Connected to PostgreSQL")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("persist-worker"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
		)
		if err == nil {
			break
		}
		slog.Info("Waiting for NATS", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to NATS", "error", err)
		os.Exit(1)
	}
	defer nc.Close()
	slog.Info("Connected to NATS", "url", nc.ConnectedUrl())

	// Create JetStream context
	js, err := jetstream.New(nc)
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	// Ensure stream exists
	_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:      "CHAT_MESSAGES",
		Subjects:  []string{"chat.*", "admin.*"},
		Retention: jetstream.LimitsPolicy,
		MaxMsgs:   10000,
		MaxAge:    7 * 24 * time.Hour,
		Storage:   jetstream.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create/update stream", "error", err)
		os.Exit(1)
	}
	slog.Info("JetStream stream CHAT_MESSAGES ready")

	// Create durable consumer
	stream, err := js.Stream(ctx, "CHAT_MESSAGES")
	if err != nil {
		slog.Error("Failed to get stream", "error", err)
		os.Exit(1)
	}

	cons, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       "persist-worker",
		AckPolicy:     jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
	})
	if err != nil {
		slog.Error("Failed to create consumer", "error", err)
		os.Exit(1)
	}
	slog.Info("JetStream consumer ready", "name", "persist-worker")

	// Prepare insert statement
	insertStmt, err := db.Prepare(
		"INSERT INTO messages (room, username, text, timestamp) VALUES ($1, $2, $3, $4)",
	)
	if err != nil {
		slog.Error("Failed to prepare insert statement", "error", err)
		os.Exit(1)
	}
	defer insertStmt.Close()

	// Consume messages with tracing
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		// Extract trace context from JetStream message headers and start span
		natsMsg := &nats.Msg{
			Subject: msg.Subject(),
			Data:    msg.Data(),
			Header:  msg.Headers(),
		}
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), natsMsg, "persist message")
		defer span.End()

		var chatMsg ChatMessage
		if err := json.Unmarshal(msg.Data(), &chatMsg); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal message", "error", err)
			span.RecordError(err)
			msg.Ack()
			return
		}

		if chatMsg.Room == "" {
			chatMsg.Room = msg.Subject()
		}

		span.SetAttributes(
			attribute.String("chat.room", chatMsg.Room),
			attribute.String("chat.user", chatMsg.User),
		)

		_, err := insertStmt.ExecContext(ctx, chatMsg.Room, chatMsg.User, chatMsg.Text, chatMsg.Timestamp)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to insert message", "error", err, "room", chatMsg.Room)
			span.RecordError(err)
			errorCounter.Add(ctx, 1, otel.WithAttributes(attribute.String("room", chatMsg.Room)))
			msg.Nak()
			return
		}

		persistedCounter.Add(ctx, 1, otel.WithAttributes(attribute.String("room", chatMsg.Room)))
		msg.Ack()
	})
	if err != nil {
		slog.Error("Failed to start consumer", "error", err)
		os.Exit(1)
	}
	defer cc.Stop()

	slog.Info("Consuming messages from CHAT_MESSAGES stream")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down persist worker")
}
```

**Step 3: Run go mod tidy and verify build**

```bash
cd persist-worker && go mod tidy && go build ./...
```

Expected: BUILD OK

**Step 4: Commit**

```bash
git add persist-worker/
git commit -m "feat: instrument persist-worker with OpenTelemetry tracing, metrics, slog"
```

---

### Task 5: Instrument history-service

Add OTel instrumentation to the history-service.

**Files:**
- Modify: `history-service/go.mod`
- Modify: `history-service/main.go`

**Step 1: Update go.mod**

Add otelhelper dependency and OTel packages to `history-service/go.mod`:

```
require (
	github.com/XSAM/otelsql v0.35.0
	github.com/example/nats-chat-otelhelper v0.0.0
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/metric v1.34.0
	go.opentelemetry.io/otel/trace v1.34.0
)

replace github.com/example/nats-chat-otelhelper => ../pkg/otelhelper
```

Then run `cd history-service && go mod tidy`.

**Step 2: Update main.go with OTel instrumentation**

Replace the entire `history-service/main.go`. Key changes:
- Call `otelhelper.Init(ctx)` at startup
- Wrap `sql.Open` with `otelsql.Open`
- In the subscribe handler: call `otelhelper.StartServerSpan` (this is a request/reply responder)
- Use `queryStmt.QueryContext(ctx, ...)` so otelsql traces the query
- Add metrics: `history_requests_total` counter, `history_request_duration_seconds` histogram
- Replace `log.Printf` with `slog`

```go
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type ChatMessage struct {
	User      string `json:"user"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
	Room      string `json:"room"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx := context.Background()

	// Initialize OpenTelemetry
	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("history-service")
	requestCounter, _ := meter.Int64Counter("history_requests_total")
	requestDuration, _ := meter.Float64Histogram("history_request_duration_seconds")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "history-service")
	natsPass := envOrDefault("NATS_PASS", "history-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	slog.Info("Starting History Service")

	// Connect to PostgreSQL with otelsql
	db, err := otelsql.Open("postgres", dbURL,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL),
	)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	for attempt := 1; attempt <= 30; attempt++ {
		err = db.Ping()
		if err == nil {
			break
		}
		slog.Info("Waiting for PostgreSQL", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to PostgreSQL", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	slog.Info("Connected to PostgreSQL")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("history-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
		)
		if err == nil {
			break
		}
		slog.Info("Waiting for NATS", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to NATS", "error", err)
		os.Exit(1)
	}
	defer nc.Close()
	slog.Info("Connected to NATS", "url", nc.ConnectedUrl())

	// Prepare query statement
	queryStmt, err := db.Prepare(
		"SELECT room, username, text, timestamp FROM messages WHERE room = $1 ORDER BY timestamp DESC LIMIT 50",
	)
	if err != nil {
		slog.Error("Failed to prepare query", "error", err)
		os.Exit(1)
	}
	defer queryStmt.Close()

	// Subscribe to history requests with tracing
	_, err = nc.Subscribe("chat.history.*", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "history request")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("chat.room", room))

		rows, err := queryStmt.QueryContext(ctx, room)
		if err != nil {
			slog.ErrorContext(ctx, "Query failed", "room", room, "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var messages []ChatMessage
		for rows.Next() {
			var m ChatMessage
			if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp); err != nil {
				slog.WarnContext(ctx, "Failed to scan row", "error", err)
				continue
			}
			messages = append(messages, m)
		}

		// Reverse to chronological order (query was DESC)
		for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
			messages[i], messages[j] = messages[j], messages[i]
		}

		if messages == nil {
			messages = []ChatMessage{}
		}

		data, err := json.Marshal(messages)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal history", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}

		msg.Respond(data)

		duration := time.Since(start).Seconds()
		attrs := otel.WithAttributes(attribute.String("room", room))
		requestCounter.Add(ctx, 1, attrs)
		requestDuration.Record(ctx, duration, attrs)

		span.SetAttributes(attribute.Int("history.message_count", len(messages)))
		slog.InfoContext(ctx, "Served history", "room", room, "count", len(messages), "duration_ms", time.Since(start).Milliseconds())
	})
	if err != nil {
		slog.Error("Failed to subscribe", "error", err)
		os.Exit(1)
	}
	slog.Info("Subscribed to chat.history.* — ready to serve history requests")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down history service")
	nc.Drain()
}
```

**Step 3: Run go mod tidy and verify build**

```bash
cd history-service && go mod tidy && go build ./...
```

Expected: BUILD OK

**Step 4: Commit**

```bash
git add history-service/
git commit -m "feat: instrument history-service with OpenTelemetry tracing, metrics, slog"
```

---

### Task 6: Instrument auth-service

Add OTel instrumentation to the auth-service.

**Files:**
- Modify: `auth-service/go.mod`
- Modify: `auth-service/main.go`
- Modify: `auth-service/handler.go`
- Modify: `auth-service/keycloak.go`

**Step 1: Update go.mod**

Add otelhelper dependency and OTel packages:

```
require (
	github.com/MicahParks/keyfunc/v2 v2.1.0
	github.com/example/nats-chat-otelhelper v0.0.0
	github.com/golang-jwt/jwt/v5 v5.2.1
	github.com/nats-io/jwt/v2 v2.7.3
	github.com/nats-io/nats.go v1.38.0
	github.com/nats-io/nkeys v0.4.9
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/metric v1.34.0
	go.opentelemetry.io/otel/trace v1.34.0
)

replace github.com/example/nats-chat-otelhelper => ../pkg/otelhelper
```

Then run `cd auth-service && go mod tidy`.

**Step 2: Update main.go — add OTel init and metrics**

Add OTel initialization at the start of `main()`, before any other setup:

```go
// At the top of main(), before loadConfig():
ctx := context.Background()
otelShutdown, err := otelhelper.Init(ctx)
if err != nil {
    slog.Error("Failed to initialize OpenTelemetry", "error", err)
    os.Exit(1)
}
defer otelShutdown(ctx)
```

Replace all `log.Printf` with `slog.Info`/`slog.Error` equivalents.

Pass the OTel meter to the handler:

```go
meter := otel.Meter("auth-service")
handler, err := NewAuthHandler(cfg, validator, meter)
```

**Step 3: Update handler.go — add tracing to auth callout**

Modify `NewAuthHandler` to accept a `metric.Meter` parameter and create counters:

```go
type AuthHandler struct {
	issuerKP       nkeys.KeyPair
	xkeyKP         nkeys.KeyPair
	validator      *KeycloakValidator
	issuerPub      string
	authCounter    metric.Int64Counter
	authDuration   metric.Float64Histogram
}

func NewAuthHandler(cfg Config, validator *KeycloakValidator, meter metric.Meter) (*AuthHandler, error) {
	// ... existing NKey setup ...
	authCounter, _ := meter.Int64Counter("auth_requests_total")
	authDuration, _ := meter.Float64Histogram("auth_request_duration_seconds")
	return &AuthHandler{
		// ... existing fields ...
		authCounter:  authCounter,
		authDuration: authDuration,
	}, nil
}
```

In the `Handle` method, wrap the entire handler in a span:

```go
func (h *AuthHandler) Handle(msg *nats.Msg) {
	start := time.Now()
	ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "auth callout")
	defer span.End()

	// ... existing logic, but use ctx for logging ...
	// On REJECT: span.SetAttributes(attribute.String("auth.result", "rejected"))
	//            h.authCounter.Add(ctx, 1, otel.WithAttributes(attribute.String("result", "rejected")))
	// On AUTHORIZED: span.SetAttributes(attribute.String("auth.result", "authorized"))
	//               h.authCounter.Add(ctx, 1, otel.WithAttributes(attribute.String("result", "authorized")))
	// At end: h.authDuration.Record(ctx, time.Since(start).Seconds())
}
```

Replace all `log.Printf` in handler.go with `slog.InfoContext(ctx, ...)` / `slog.ErrorContext(ctx, ...)`.

**Step 4: Update keycloak.go — replace log.Printf with slog**

Replace `log.Printf` calls with `slog.Info`/`slog.Error`.

**Step 5: Run go mod tidy and verify build**

```bash
cd auth-service && go mod tidy && go build ./...
```

Expected: BUILD OK

**Step 6: Commit**

```bash
git add auth-service/
git commit -m "feat: instrument auth-service with OpenTelemetry tracing, metrics, slog"
```

---

### Task 7: Integration Smoke Test

Verify the full observability stack works end-to-end.

**Step 1: Build and start all services**

```bash
docker compose down -v
docker compose up -d --build
```

Expected: 12 containers all "Up" (keycloak, nats, postgres, auth-service, persist-worker, history-service, web, otel-collector, tempo, prometheus, loki, grafana).

**Step 2: Check service logs**

```bash
docker compose logs persist-worker --tail=5
docker compose logs history-service --tail=5
docker compose logs auth-service --tail=5
docker compose logs otel-collector --tail=5
```

Expected: Each Go service logs "OpenTelemetry initialized". OTel Collector shows "Everything is ready."

**Step 3: Send test messages to generate traces**

```bash
docker run --rm --network nats-chat-keycloak_default natsio/nats-box:latest \
  nats pub -s nats://persist-worker:persist-worker-secret@nats:4222 \
  chat.general '{"user":"trace-test","text":"Hello tracing","timestamp":1739440000000,"room":"general"}'
```

Then request history:

```bash
docker run --rm --network nats-chat-keycloak_default natsio/nats-box:latest \
  nats req -s nats://history-service:history-service-secret@nats:4222 \
  chat.history.general '' --timeout=5s
```

Expected: Message persisted and history returned.

**Step 4: Verify traces in Grafana**

Open `http://localhost:3001` in a browser. Navigate to Explore > Tempo. Search for recent traces. You should see:
- `persist message` spans from persist-worker with PostgreSQL child spans
- `history request` spans from history-service with PostgreSQL child spans

**Step 5: Verify metrics in Grafana**

Navigate to Explore > Prometheus. Query:
- `messages_persisted_total` — should show count > 0
- `history_requests_total` — should show count > 0

**Step 6: Verify logs in Grafana**

Navigate to Explore > Loki. Query `{service_name="persist-worker"}`. Should show structured JSON logs with trace_id fields.

**Step 7: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: adjust observability configuration after smoke test"
```
