import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-web';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const endpoint = (window as any).__env__?.VITE_OTLP_ENDPOINT
  || import.meta.env?.VITE_OTLP_ENDPOINT
  || 'http://localhost:4318';

const provider = new WebTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'web-frontend',
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })
    ),
  ],
});

provider.register();

export const tracer = trace.getTracer('nats-chat-web', '1.0.0');
export { trace, context, propagation, SpanKind, SpanStatusCode };
