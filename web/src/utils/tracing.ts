import { tracer, trace, context, propagation, SpanKind, SpanStatusCode } from '../lib/otel';
import { headers as natsHeaders, type MsgHdrs } from 'nats.ws';

// Adapter for NATS headers to work with OTel propagation
const createCarrier = (hdrs: MsgHdrs) => ({
  get: (key: string) => hdrs.get(key) || undefined,
  set: (key: string, value: string) => hdrs.set(key, value),
  keys: () => hdrs.keys() as unknown as string[],
});

// Creates a PRODUCER span and returns NATS headers with injected trace context.
// BACKWARD COMPATIBLE: same signature as before — callers don't need changes.
export function tracedHeaders(spanName?: string): { headers: MsgHdrs; traceId: string } {
  const hdrs = natsHeaders();
  const span = tracer.startSpan(spanName || 'nats.publish', { kind: SpanKind.PRODUCER });
  const ctx = trace.setSpan(context.active(), span);
  propagation.inject(ctx, createCarrier(hdrs));
  const traceId = span.spanContext().traceId;
  span.end();
  return { headers: hdrs, traceId };
}

// Wraps a user action in a parent span, returns context for child spans
export function startActionSpan(
  name: string,
  attrs?: Record<string, string>,
): { ctx: any; end: (error?: Error) => void } {
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL });
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => span.setAttribute(k, v));
  }
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
export function tracedHeadersWithContext(parentCtx: any, spanName: string): { headers: MsgHdrs; traceId: string } {
  const hdrs = natsHeaders();
  const span = tracer.startSpan(spanName, { kind: SpanKind.PRODUCER }, parentCtx);
  const spanCtx = trace.setSpan(parentCtx, span);
  propagation.inject(spanCtx, createCarrier(hdrs));
  const traceId = span.spanContext().traceId;
  span.end();
  return { headers: hdrs, traceId };
}

// Structured console logging (kept for backward compatibility)
export function trace_log(level: 'debug' | 'info' | 'warn' | 'error', tag: string, msg: string, fields?: Record<string, any>) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const fieldStr = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  fn(`[${tag}] ${msg}${fieldStr}`);
}
