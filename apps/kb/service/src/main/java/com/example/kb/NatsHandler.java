package com.example.kb;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.nats.client.Connection;
import io.nats.client.Headers;
import io.nats.client.Message;
import io.nats.client.impl.NatsMessage;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

public class NatsHandler {

    private static final Logger log = LoggerFactory.getLogger(NatsHandler.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final PageRepository repo;
    private final EditingPresenceTracker tracker;
    private final Connection nc;
    private final Tracer tracer;

    public NatsHandler(PageRepository repo, EditingPresenceTracker tracker, Connection nc, Tracer tracer) {
        this.repo = repo;
        this.tracker = tracker;
        this.nc = nc;
        this.tracer = tracer;
    }

    public void handle(Message msg) {
        Context extractedContext = NatsTracing.extractContext(msg);
        Span span = NatsTracing.startServerSpan(extractedContext, msg, tracer, "kb.handle");
        
        try (Scope scope = span.makeCurrent()) {
            String traceId = span.getSpanContext().getTraceId();
            String spanId = span.getSpanContext().getSpanId();
            MDC.put("trace_id", traceId);
            MDC.put("span_id", spanId);

            String subject = msg.getSubject();
            String[] parts = subject.split("\\.", 4);
            if (parts.length < 4) {
                span.setStatus(StatusCode.ERROR, "invalid subject");
                respond(msg, errorJson("invalid subject"));
                return;
            }
            String room = parts[2];
            String action = parts[3];

            span.setAttribute("kb.room", room);
            span.setAttribute("kb.action", action);

            JsonNode data = msg.getData() != null && msg.getData().length > 0
                    ? mapper.readTree(msg.getData())
                    : mapper.createObjectNode();
            String username = data.has("user") ? data.get("user").asText() : "unknown";

            span.setAttribute("kb.user", username);

            log.info("Action: {} room: {} user: {}", action, room, username);

            switch (action) {
                case "list" -> handleList(msg, room, span);
                case "create" -> handleCreate(msg, room, data, username, span);
                case "load" -> handleLoad(msg, room, data, span);
                case "save" -> handleSave(msg, room, data, username, span);
                case "delete" -> handleDelete(msg, room, data, span);
                case "editing" -> handleEditing(msg, room, data, username, span);
                case "stopedit" -> handleStopEdit(msg, room, data, username, span);
                default -> {
                    span.setStatus(StatusCode.ERROR, "unknown action");
                    respond(msg, errorJson("unknown action: " + action));
                }
            }
        } catch (Exception e) {
            span.setStatus(StatusCode.ERROR, e.getMessage());
            span.recordException(e);
            log.error("Error handling message: {}", e.getMessage(), e);
            respond(msg, errorJson(e.getMessage()));
        } finally {
            MDC.remove("trace_id");
            MDC.remove("span_id");
            span.end();
        }
    }

    private void handleList(Message msg, String room, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.list")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            List<Map<String, Object>> pages = repo.listPages(room);
            ObjectNode result = mapper.createObjectNode();
            ArrayNode arr = result.putArray("pages");
            for (Map<String, Object> page : pages) {
                ObjectNode p = arr.addObject();
                p.put("id", (String) page.get("id"));
                p.put("title", (String) page.get("title"));
                p.put("updatedBy", (String) page.get("updated_by"));
                p.put("updatedAt", page.get("updated_at").toString());
            }
            span.setAttribute("kb.page_count", pages.size());
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void handleCreate(Message msg, String room, JsonNode data, String username, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.create")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .setAttribute("kb.user", username)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            String title = data.has("title") ? data.get("title").asText() : "Untitled";
            String id = repo.createPage(room, title, username);
            span.setAttribute("kb.page_id", id);
            ObjectNode result = mapper.createObjectNode();
            result.put("id", id);
            result.put("title", title);
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void handleLoad(Message msg, String room, JsonNode data, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.load")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
            if (pageId == null) {
                span.setStatus(StatusCode.ERROR, "pageId required");
                respond(msg, errorJson("pageId required"));
                return;
            }
            span.setAttribute("kb.page_id", pageId);

            Map<String, Object> page = repo.loadPage(pageId, room);
            if (page == null) {
                span.setStatus(StatusCode.ERROR, "page not found");
                respond(msg, errorJson("page not found"));
                return;
            }
            ObjectNode result = mapper.createObjectNode();
            result.put("id", (String) page.get("id"));
            result.put("title", (String) page.get("title"));
            result.put("content", (String) page.get("content"));
            result.put("createdBy", (String) page.get("created_by"));
            result.put("updatedBy", (String) page.get("updated_by"));
            result.put("createdAt", page.get("created_at").toString());
            result.put("updatedAt", page.get("updated_at").toString());
            ArrayNode editorsArr = result.putArray("editors");
            for (String editor : tracker.getEditors(pageId)) {
                editorsArr.add(editor);
            }
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void handleSave(Message msg, String room, JsonNode data, String username, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.save")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .setAttribute("kb.user", username)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
            String title = data.has("title") ? data.get("title").asText() : null;
            String content = data.has("content") ? data.get("content").asText() : null;
            if (pageId == null) {
                span.setStatus(StatusCode.ERROR, "pageId required");
                respond(msg, errorJson("pageId required"));
                return;
            }
            span.setAttribute("kb.page_id", pageId);
            boolean ok = repo.savePage(pageId, room, title, content, username);
            ObjectNode result = mapper.createObjectNode();
            result.put("ok", ok);
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void handleDelete(Message msg, String room, JsonNode data, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.delete")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
            if (pageId == null) {
                span.setStatus(StatusCode.ERROR, "pageId required");
                respond(msg, errorJson("pageId required"));
                return;
            }
            span.setAttribute("kb.page_id", pageId);
            boolean ok = repo.deletePage(pageId, room);
            ObjectNode result = mapper.createObjectNode();
            result.put("ok", ok);
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void handleEditing(Message msg, String room, JsonNode data, String username, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.editing")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .setAttribute("kb.user", username)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
            if (pageId == null) {
                span.setStatus(StatusCode.ERROR, "pageId required");
                respond(msg, errorJson("pageId required"));
                return;
            }
            span.setAttribute("kb.page_id", pageId);
            tracker.addEditor(pageId, username);
            publishPresence(room, pageId);
            ObjectNode result = mapper.createObjectNode();
            result.put("ok", true);
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void handleStopEdit(Message msg, String room, JsonNode data, String username, Span parentSpan) throws Exception {
        Span span = tracer.spanBuilder("kb.stopedit")
                .setParent(Context.current())
                .setAttribute("kb.room", room)
                .setAttribute("kb.user", username)
                .startSpan();
        try (Scope scope = span.makeCurrent()) {
            String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
            if (pageId == null) {
                span.setStatus(StatusCode.ERROR, "pageId required");
                respond(msg, errorJson("pageId required"));
                return;
            }
            span.setAttribute("kb.page_id", pageId);
            tracker.removeEditor(pageId, username);
            publishPresence(room, pageId);
            ObjectNode result = mapper.createObjectNode();
            result.put("ok", true);
            respond(msg, result);
        } finally {
            span.end();
        }
    }

    private void publishPresence(String room, String pageId) {
        try {
            ObjectNode payload = mapper.createObjectNode();
            payload.put("pageId", pageId);
            ArrayNode editorsArr = payload.putArray("editors");
            for (String editor : tracker.getEditors(pageId)) {
                editorsArr.add(editor);
            }
            String subject = "app.kb." + room + ".presence";
            byte[] data = mapper.writeValueAsBytes(payload);

            NatsMessage msg = NatsMessage.builder()
                    .subject(subject)
                    .data(data)
                    .headers(new Headers())
                    .build();
            NatsTracing.injectContext(Context.current(), msg);
            nc.publish(msg);
        } catch (Exception e) {
            log.error("Failed to publish presence: {}", e.getMessage(), e);
        }
    }

    private void respond(Message msg, JsonNode json) {
        try {
            if (msg.getReplyTo() != null) {
                msg.getConnection().publish(msg.getReplyTo(), mapper.writeValueAsBytes(json));
            }
        } catch (Exception e) {
            log.error("Failed to respond: {}", e.getMessage(), e);
        }
    }

    private ObjectNode errorJson(String message) {
        ObjectNode node = mapper.createObjectNode();
        node.put("error", message);
        return node;
    }
}
