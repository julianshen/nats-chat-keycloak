package otelhelper

import (
	"context"

	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
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
