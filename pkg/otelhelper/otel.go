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
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// NATSLatencyBuckets are histogram boundaries tuned for NATS messaging latencies.
var NATSLatencyBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5}

// NewDurationHistogram creates a Float64Histogram with NATS-tuned boundaries.
func NewDurationHistogram(meter metric.Meter, name, description string) (metric.Float64Histogram, error) {
	return meter.Float64Histogram(name,
		metric.WithDescription(description),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(NATSLatencyBuckets...),
	)
}

// tracingHandler is an slog.Handler wrapper that auto-injects trace_id and
// span_id from the span context into every log record. This enables Grafana
// to cross-link Loki logs with Tempo traces.
type tracingHandler struct {
	inner slog.Handler
}

func (h *tracingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *tracingHandler) Handle(ctx context.Context, record slog.Record) error {
	spanCtx := oteltrace.SpanContextFromContext(ctx)
	if spanCtx.HasTraceID() {
		record.AddAttrs(slog.String("trace_id", spanCtx.TraceID().String()))
	}
	if spanCtx.HasSpanID() {
		record.AddAttrs(slog.String("span_id", spanCtx.SpanID().String()))
	}
	return h.inner.Handle(ctx, record)
}

func (h *tracingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &tracingHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *tracingHandler) WithGroup(name string) slog.Handler {
	return &tracingHandler{inner: h.inner.WithGroup(name)}
}

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

	// Wrap a fresh JSONHandler with tracingHandler so all slog.*Context(ctx, ...)
	// calls automatically include trace_id/span_id from the active span.
	// Note: we must NOT wrap slog.Default().Handler() (the defaultHandler) because
	// it routes through log.Logger which redirects back to slog, causing a deadlock.
	slog.SetDefault(slog.New(&tracingHandler{inner: slog.NewJSONHandler(os.Stderr, nil)}))

	slog.Info("OpenTelemetry initialized", "service", serviceName)

	return shutdown, nil
}
