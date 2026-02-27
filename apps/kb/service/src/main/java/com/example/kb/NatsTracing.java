package com.example.kb;

import io.nats.client.Message;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

public class NatsTracing {

    private static final String TRACE_PARENT = "traceparent";

    public static Context extractContext(Message msg) {
        TextMapGetter<Message> getter = new TextMapGetter<>() {
            @Override
            public Iterable<String> keys(Message carrier) {
                if (carrier.getHeaders() == null) {
                    return Collections.emptyList();
                }
                return carrier.getHeaders().keySet();
            }

            @Override
            public String get(Message carrier, String key) {
                if (carrier.getHeaders() == null) {
                    return null;
                }
                return carrier.getHeaders().getFirst(key);
            }
        };

        return W3CTraceContextPropagator.getInstance().extract(Context.current(), msg, getter);
    }

    public static Span startConsumerSpan(Context extractedContext, Message msg, Tracer tracer, String spanName) {
        String subject = msg.getSubject();
        long payloadSize = msg.getData() != null ? msg.getData().length : 0;

        return tracer.spanBuilder(spanName)
                .setParent(extractedContext)
                .setSpanKind(SpanKind.CONSUMER)
                .setAttribute("messaging.system", "nats")
                .setAttribute("messaging.destination.name", subject)
                .setAttribute("messaging.message.payload_size_bytes", payloadSize)
                .startSpan();
    }

    public static Span startServerSpan(Context extractedContext, Message msg, Tracer tracer, String spanName) {
        String subject = msg.getSubject();
        long payloadSize = msg.getData() != null ? msg.getData().length : 0;

        return tracer.spanBuilder(spanName)
                .setParent(extractedContext)
                .setSpanKind(SpanKind.SERVER)
                .setAttribute("messaging.system", "nats")
                .setAttribute("messaging.destination.name", subject)
                .setAttribute("messaging.message.payload_size_bytes", payloadSize)
                .startSpan();
    }

    public static void injectContext(Context context, Message msg) {
        Map<String, String> headers = new HashMap<>();
        TextMapSetter<Map<String, String>> setter = (carrier, key, value) -> {
            if (carrier != null) {
                carrier.put(key, value);
            }
        };

        W3CTraceContextPropagator.getInstance().inject(context, headers, setter);

        for (Map.Entry<String, String> entry : headers.entrySet()) {
            msg.getHeaders().add(entry.getKey(), entry.getValue());
        }
    }
}
