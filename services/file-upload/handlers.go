package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"time"

	"github.com/example/nats-chat-mediatoken"
)

var validContentType = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$`)

// FileMetadata stores metadata about an uploaded file.
type FileMetadata struct {
	ID          string `json:"id"`
	Room        string `json:"room"`
	Uploader    string `json:"uploader"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	CreatedAt   int64  `json:"createdAt"`
}

// UploadRequest is sent by the client to request an upload URL.
type UploadRequest struct {
	Room        string `json:"room"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType,omitempty"`
}

// UploadResponse is returned with the pre-signed upload URL.
type UploadResponse struct {
	UploadURL string `json:"uploadUrl"`
	Token     string `json:"token"`
	FileID    string `json:"fileId"`
}

// DownloadRequest is sent by the client to request a download URL.
type DownloadRequest struct {
	FileID string `json:"fileId"`
}

// DownloadResponse is returned with the pre-signed download URL.
type DownloadResponse struct {
	DownloadURL string `json:"downloadUrl"`
	Token       string `json:"token"`
}

// UploadedNotification is sent by the client after a successful upload.
// The token field must be the original upload JWT — the service verifies it
// and extracts fileId/room from claims instead of trusting client-supplied values.
type UploadedNotification struct {
	Token       string `json:"token"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

// service holds the file-upload microservice state.
type service struct {
	db              *sql.DB
	mediaBaseURL    string
	tokenSecret     []byte
	tokenTTL        time.Duration
	genID           func() string
	checkMembership func(room, username string) bool
}

func (s *service) generateID() string {
	if s.genID != nil {
		return s.genID()
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// handleUploadRequest checks membership and returns a pre-signed upload URL with JWT.
func (s *service) handleUploadRequest(username string, data []byte) ([]byte, error) {
	var req UploadRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return json.Marshal(map[string]string{"error": "invalid request"})
	}
	if req.Room == "" || req.Filename == "" {
		return json.Marshal(map[string]string{"error": "room and filename are required"})
	}

	if s.checkMembership != nil && !s.checkMembership(req.Room, username) {
		slog.Warn("Upload request denied: non-member", "user", username, "room", req.Room)
		return json.Marshal(map[string]string{"error": "forbidden: not a member of this room"})
	}

	fileID := s.generateID()
	token, err := mediatoken.Sign(s.tokenSecret, mediatoken.Claims{
		Action:   "upload",
		FileID:   fileID,
		Room:     req.Room,
		Username: username,
		Exp:      time.Now().Add(s.tokenTTL).Unix(),
	})
	if err != nil {
		return json.Marshal(map[string]string{"error": "token generation failed"})
	}

	return json.Marshal(UploadResponse{
		UploadURL: fmt.Sprintf("%s/upload/%s?token=%s", s.mediaBaseURL, fileID, token),
		Token:     token,
		FileID:    fileID,
	})
}

// handleDownloadRequest checks membership and returns a pre-signed download URL with JWT.
func (s *service) handleDownloadRequest(username string, data []byte) ([]byte, error) {
	var req DownloadRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return json.Marshal(map[string]string{"error": "invalid request"})
	}
	if req.FileID == "" {
		return json.Marshal(map[string]string{"error": "fileId is required"})
	}

	var meta FileMetadata
	if s.db != nil {
		row := s.db.QueryRow(
			`SELECT id, room, uploader, filename, size, content_type, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint FROM files WHERE id = $1`, req.FileID)
		if err := row.Scan(&meta.ID, &meta.Room, &meta.Uploader, &meta.Filename, &meta.Size, &meta.ContentType, &meta.CreatedAt); err != nil {
			return json.Marshal(map[string]string{"error": "file not found"})
		}
	} else {
		return json.Marshal(map[string]string{"error": "file not found"})
	}

	if s.checkMembership != nil && !s.checkMembership(meta.Room, username) {
		slog.Warn("Download request denied: non-member", "user", username, "room", meta.Room)
		return json.Marshal(map[string]string{"error": "forbidden: not a member of this room"})
	}

	token, err := mediatoken.Sign(s.tokenSecret, mediatoken.Claims{
		Action:      "download",
		FileID:      meta.ID,
		Room:        meta.Room,
		Username:    username,
		Filename:    meta.Filename,
		ContentType: meta.ContentType,
		Exp:         time.Now().Add(s.tokenTTL).Unix(),
	})
	if err != nil {
		return json.Marshal(map[string]string{"error": "token generation failed"})
	}

	return json.Marshal(DownloadResponse{
		DownloadURL: fmt.Sprintf("%s/files/%s?token=%s", s.mediaBaseURL, meta.ID, token),
		Token:       token,
	})
}

// handleUploaded verifies the upload token and persists file metadata.
// The token proves the upload was authorized by this service — room and fileId
// are extracted from token claims, not from the client body.
//
// Note: membership is NOT re-checked here. A user removed from a room between
// token issuance and this call could still register metadata. The token TTL
// (default 5min) limits this TOCTOU window, which is an accepted trade-off
// to avoid an extra membership RPC on every upload completion.
func (s *service) handleUploaded(username string, data []byte) ([]byte, error) {
	var notif UploadedNotification
	if err := json.Unmarshal(data, &notif); err != nil {
		return json.Marshal(map[string]string{"error": "invalid request"})
	}
	if notif.Token == "" {
		return json.Marshal(map[string]string{"error": "upload token is required"})
	}

	claims, err := mediatoken.Verify(s.tokenSecret, notif.Token)
	if err != nil {
		slog.Warn("Upload notification rejected: invalid token", "error", err)
		return json.Marshal(map[string]string{"error": "invalid or expired upload token"})
	}
	if claims.Action != "upload" {
		return json.Marshal(map[string]string{"error": "token action mismatch"})
	}
	if claims.Username != username {
		slog.Warn("Upload notification rejected: user mismatch", "token_user", claims.Username, "nats_user", username)
		return json.Marshal(map[string]string{"error": "token user mismatch"})
	}

	// Validate client-supplied metadata
	filename := notif.Filename
	if len(filename) > 255 {
		filename = filename[:255]
	}
	contentType := notif.ContentType
	if len(contentType) > 255 || (contentType != "" && !validContentType.MatchString(contentType)) {
		contentType = "application/octet-stream"
	}
	if notif.Size < 0 {
		notif.Size = 0
	}

	if s.db != nil {
		_, err := s.db.Exec(
			`INSERT INTO files (id, room, uploader, filename, size, content_type) VALUES ($1, $2, $3, $4, $5, $6)`,
			claims.FileID, claims.Room, username, filename, notif.Size, contentType,
		)
		if err != nil {
			slog.Error("Failed to persist file metadata", "id", claims.FileID, "error", err)
			return json.Marshal(map[string]string{"error": "failed to save metadata"})
		}
	}

	return json.Marshal(map[string]string{"status": "ok", "fileId": claims.FileID})
}

// handleFileInfo returns file metadata by ID after verifying room membership.
func (s *service) handleFileInfo(username, fileID string) ([]byte, error) {
	if s.db == nil {
		return json.Marshal(map[string]string{"error": "not found"})
	}
	var meta FileMetadata
	row := s.db.QueryRow(
		`SELECT id, room, uploader, filename, size, content_type, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint FROM files WHERE id = $1`, fileID)
	if err := row.Scan(&meta.ID, &meta.Room, &meta.Uploader, &meta.Filename, &meta.Size, &meta.ContentType, &meta.CreatedAt); err != nil {
		return json.Marshal(map[string]string{"error": "not found"})
	}
	if s.checkMembership != nil && !s.checkMembership(meta.Room, username) {
		return json.Marshal(map[string]string{"error": "forbidden: not a member of this room"})
	}
	return json.Marshal(meta)
}

// handleFileList returns files in a room after verifying membership.
func (s *service) handleFileList(username, room string) ([]byte, error) {
	if s.checkMembership != nil && !s.checkMembership(room, username) {
		return json.Marshal(map[string]string{"error": "forbidden: not a member of this room"})
	}
	if s.db == nil {
		return json.Marshal([]FileMetadata{})
	}
	rows, err := s.db.Query(
		`SELECT id, room, uploader, filename, size, content_type, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint FROM files WHERE room = $1 ORDER BY created_at DESC LIMIT 50`, room)
	if err != nil {
		return json.Marshal([]FileMetadata{})
	}
	defer rows.Close()

	var result []FileMetadata
	for rows.Next() {
		var f FileMetadata
		if err := rows.Scan(&f.ID, &f.Room, &f.Uploader, &f.Filename, &f.Size, &f.ContentType, &f.CreatedAt); err != nil {
			continue
		}
		result = append(result, f)
	}
	if result == nil {
		result = []FileMetadata{}
	}
	return json.Marshal(result)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
