package com.example.kb;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Repository
public class PageRepository {

    private final JdbcTemplate jdbc;

    public PageRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Map<String, Object>> listPages(String room) {
        return jdbc.queryForList(
                "SELECT id, title, updated_by, updated_at FROM kb_pages WHERE room = ? ORDER BY updated_at DESC",
                room);
    }

    public String createPage(String room, String title, String username) {
        String id = UUID.randomUUID().toString();
        jdbc.update(
                "INSERT INTO kb_pages (id, room, title, content, created_by, updated_by) VALUES (?, ?, ?, '', ?, ?)",
                id, room, title, username, username);
        return id;
    }

    public Map<String, Object> loadPage(String id, String room) {
        var results = jdbc.queryForList(
                "SELECT id, title, content, created_by, updated_by, created_at, updated_at FROM kb_pages WHERE id = ? AND room = ?",
                id, room);
        return results.isEmpty() ? null : results.get(0);
    }

    public boolean savePage(String id, String room, String title, String content, String username) {
        int rows = jdbc.update(
                "UPDATE kb_pages SET title = ?, content = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND room = ?",
                title, content, username, id, room);
        return rows > 0;
    }

    public boolean deletePage(String id, String room) {
        int rows = jdbc.update("DELETE FROM kb_pages WHERE id = ? AND room = ?", id, room);
        return rows > 0;
    }
}
