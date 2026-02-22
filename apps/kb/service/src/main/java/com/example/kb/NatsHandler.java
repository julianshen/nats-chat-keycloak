package com.example.kb;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.nats.client.Connection;
import io.nats.client.Message;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

public class NatsHandler {

    private static final Logger log = LoggerFactory.getLogger(NatsHandler.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final PageRepository repo;
    private final EditingPresenceTracker tracker;
    private final Connection nc;

    public NatsHandler(PageRepository repo, EditingPresenceTracker tracker, Connection nc) {
        this.repo = repo;
        this.tracker = tracker;
        this.nc = nc;
    }

    public void handle(Message msg) {
        try {
            String subject = msg.getSubject();
            // subject format: app.kb.{room}.{action}
            String[] parts = subject.split("\\.", 4);
            if (parts.length < 4) {
                respond(msg, errorJson("invalid subject"));
                return;
            }
            String room = parts[2];
            String action = parts[3];

            JsonNode data = msg.getData() != null && msg.getData().length > 0
                    ? mapper.readTree(msg.getData())
                    : mapper.createObjectNode();
            String username = data.has("user") ? data.get("user").asText() : "unknown";

            log.info("Action: {} room: {} user: {}", action, room, username);

            switch (action) {
                case "list" -> handleList(msg, room);
                case "create" -> handleCreate(msg, room, data, username);
                case "load" -> handleLoad(msg, room, data);
                case "save" -> handleSave(msg, room, data, username);
                case "delete" -> handleDelete(msg, room, data);
                case "editing" -> handleEditing(msg, room, data, username);
                case "stopedit" -> handleStopEdit(msg, room, data, username);
                default -> respond(msg, errorJson("unknown action: " + action));
            }
        } catch (Exception e) {
            log.error("Error handling message: {}", e.getMessage(), e);
            respond(msg, errorJson(e.getMessage()));
        }
    }

    private void handleList(Message msg, String room) throws Exception {
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
        respond(msg, result);
    }

    private void handleCreate(Message msg, String room, JsonNode data, String username) throws Exception {
        String title = data.has("title") ? data.get("title").asText() : "Untitled";
        String id = repo.createPage(room, title, username);
        ObjectNode result = mapper.createObjectNode();
        result.put("id", id);
        result.put("title", title);
        respond(msg, result);
    }

    private void handleLoad(Message msg, String room, JsonNode data) throws Exception {
        String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
        if (pageId == null) {
            respond(msg, errorJson("pageId required"));
            return;
        }
        Map<String, Object> page = repo.loadPage(pageId, room);
        if (page == null) {
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
    }

    private void handleSave(Message msg, String room, JsonNode data, String username) throws Exception {
        String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
        String title = data.has("title") ? data.get("title").asText() : null;
        String content = data.has("content") ? data.get("content").asText() : null;
        if (pageId == null) {
            respond(msg, errorJson("pageId required"));
            return;
        }
        boolean ok = repo.savePage(pageId, room, title, content, username);
        ObjectNode result = mapper.createObjectNode();
        result.put("ok", ok);
        respond(msg, result);
    }

    private void handleDelete(Message msg, String room, JsonNode data) throws Exception {
        String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
        if (pageId == null) {
            respond(msg, errorJson("pageId required"));
            return;
        }
        boolean ok = repo.deletePage(pageId, room);
        ObjectNode result = mapper.createObjectNode();
        result.put("ok", ok);
        respond(msg, result);
    }

    private void handleEditing(Message msg, String room, JsonNode data, String username) throws Exception {
        String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
        if (pageId == null) {
            respond(msg, errorJson("pageId required"));
            return;
        }
        tracker.addEditor(pageId, username);
        publishPresence(room, pageId);
        ObjectNode result = mapper.createObjectNode();
        result.put("ok", true);
        respond(msg, result);
    }

    private void handleStopEdit(Message msg, String room, JsonNode data, String username) throws Exception {
        String pageId = data.has("pageId") ? data.get("pageId").asText() : null;
        if (pageId == null) {
            respond(msg, errorJson("pageId required"));
            return;
        }
        tracker.removeEditor(pageId, username);
        publishPresence(room, pageId);
        ObjectNode result = mapper.createObjectNode();
        result.put("ok", true);
        respond(msg, result);
    }

    private void publishPresence(String room, String pageId) {
        try {
            ObjectNode payload = mapper.createObjectNode();
            payload.put("pageId", pageId);
            ArrayNode editorsArr = payload.putArray("editors");
            for (String editor : tracker.getEditors(pageId)) {
                editorsArr.add(editor);
            }
            nc.publish("app.kb." + room + ".presence", mapper.writeValueAsBytes(payload));
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
