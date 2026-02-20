import { headers as natsHeaders, type MsgHdrs } from 'nats.ws';

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates nats.ws MsgHdrs with a W3C traceparent header injected.
 * Each call generates a fresh traceId + spanId so every publish/request
 * starts a new trace that backend services can continue.
 */
export function tracedHeaders(): { headers: MsgHdrs; traceId: string } {
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  const h = natsHeaders();
  h.set('traceparent', `00-${traceId}-${spanId}-01`);
  return { headers: h, traceId };
}

/**
 * Structured console logging with optional traceId for browser DevTools correlation.
 * Output format: [tag] message {fields} (traceId=...)
 */
export function trace(
  level: 'debug' | 'info' | 'warn' | 'error',
  tag: string,
  msg: string,
  fields?: Record<string, unknown>,
) {
  const parts: string[] = [`[${tag}] ${msg}`];
  if (fields) {
    const entries = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    parts.push(entries);
  }
  const line = parts.join(' ');
  switch (level) {
    case 'debug': console.debug(line); break;
    case 'info':  console.log(line);   break;
    case 'warn':  console.warn(line);  break;
    case 'error': console.error(line); break;
  }
}
