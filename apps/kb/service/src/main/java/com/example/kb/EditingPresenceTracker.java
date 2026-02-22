package com.example.kb;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class EditingPresenceTracker {

    private static final long STALE_SECONDS = 60;

    // pageId -> { username -> lastSeen }
    private final ConcurrentHashMap<String, ConcurrentHashMap<String, Instant>> editors = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "presence-cleanup");
        t.setDaemon(true);
        return t;
    });

    public EditingPresenceTracker() {
        scheduler.scheduleAtFixedRate(this::cleanupStale, 30, 30, TimeUnit.SECONDS);
    }

    public void addEditor(String pageId, String username) {
        editors.computeIfAbsent(pageId, k -> new ConcurrentHashMap<>())
                .put(username, Instant.now());
    }

    public void removeEditor(String pageId, String username) {
        var pageEditors = editors.get(pageId);
        if (pageEditors != null) {
            pageEditors.remove(username);
            if (pageEditors.isEmpty()) {
                editors.remove(pageId);
            }
        }
    }

    public List<String> getEditors(String pageId) {
        var pageEditors = editors.get(pageId);
        if (pageEditors == null) return List.of();
        return List.copyOf(pageEditors.keySet());
    }

    private void cleanupStale() {
        Instant cutoff = Instant.now().minusSeconds(STALE_SECONDS);
        for (Map.Entry<String, ConcurrentHashMap<String, Instant>> entry : editors.entrySet()) {
            entry.getValue().entrySet().removeIf(e -> e.getValue().isBefore(cutoff));
            if (entry.getValue().isEmpty()) {
                editors.remove(entry.getKey());
            }
        }
    }
}
