package main

import (
	"crypto/rsa"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type contextKey string

const ctxUsernameKey contextKey = "username"

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

// handlers holds the HTTP handler state.
type handlers struct {
	storage         Storage
	db              *sql.DB
	maxUploadSize   int64
	genID           func() string
	checkMembership func(room, username string) bool

	// In-memory cache for file metadata (also persisted to DB when available)
	filesMu sync.RWMutex
	files   map[string]FileMetadata
}

func (h *handlers) generateID() string {
	if h.genID != nil {
		return h.genID()
	}
	// Default: use timestamp-based ID (uuid added in main.go with full deps)
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (h *handlers) handleUpload(w http.ResponseWriter, r *http.Request) {
	username, _ := r.Context().Value(ctxUsernameKey).(string)
	if username == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxUploadSize)
	if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}

	room := r.FormValue("room")
	if room == "" {
		http.Error(w, "room is required", http.StatusBadRequest)
		return
	}

	// Verify user is a member of the room
	if h.checkMembership != nil && !h.checkMembership(room, username) {
		slog.WarnContext(r.Context(), "Upload rejected: non-member", "user", username, "room", room)
		http.Error(w, "forbidden: not a member of this room", http.StatusForbidden)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	id := h.generateID()
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if err := h.storage.Save(r.Context(), id, file, contentType); err != nil {
		slog.ErrorContext(r.Context(), "Failed to save file", "error", err)
		http.Error(w, "failed to save file", http.StatusInternalServerError)
		return
	}

	meta := FileMetadata{
		ID:          id,
		Room:        room,
		Uploader:    username,
		Filename:    header.Filename,
		Size:        header.Size,
		ContentType: contentType,
		CreatedAt:   time.Now().UnixMilli(),
	}

	// Persist to DB if available
	if h.db != nil {
		_, err := h.db.ExecContext(r.Context(),
			`INSERT INTO files (id, room, uploader, filename, size, content_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			meta.ID, meta.Room, meta.Uploader, meta.Filename, meta.Size, meta.ContentType, time.UnixMilli(meta.CreatedAt),
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "Failed to insert file metadata", "error", err)
			_ = h.storage.Delete(r.Context(), id)
			http.Error(w, "failed to save metadata", http.StatusInternalServerError)
			return
		}
	}

	// Cache in memory
	h.filesMu.Lock()
	if h.files == nil {
		h.files = make(map[string]FileMetadata)
	}
	h.files[id] = meta
	h.filesMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(meta)
}

func (h *handlers) handleDownload(w http.ResponseWriter, r *http.Request) {
	username, _ := r.Context().Value(ctxUsernameKey).(string)
	if username == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "file id required", http.StatusBadRequest)
		return
	}

	// Look up metadata
	h.filesMu.RLock()
	meta, ok := h.files[id]
	h.filesMu.RUnlock()

	if !ok && h.db != nil {
		row := h.db.QueryRowContext(r.Context(),
			`SELECT id, room, uploader, filename, size, content_type, EXTRACT(EPOCH FROM created_at)::bigint * 1000 FROM files WHERE id = $1`, id)
		err := row.Scan(&meta.ID, &meta.Room, &meta.Uploader, &meta.Filename, &meta.Size, &meta.ContentType, &meta.CreatedAt)
		if err == nil {
			ok = true
			h.filesMu.Lock()
			h.files[id] = meta
			h.filesMu.Unlock()
		}
	}

	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	// Verify user is a member of the file's room
	if h.checkMembership != nil && !h.checkMembership(meta.Room, username) {
		slog.WarnContext(r.Context(), "Download rejected: non-member", "user", username, "room", meta.Room, "file", id)
		http.Error(w, "forbidden: not a member of this room", http.StatusForbidden)
		return
	}

	rc, err := h.storage.Open(r.Context(), id)
	if err != nil {
		slog.ErrorContext(r.Context(), "Failed to open file", "id", id, "error", err)
		http.Error(w, "file not found in storage", http.StatusNotFound)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, meta.Filename))
	io.Copy(w, rc)
}

// JWKS types for Keycloak key fetching
type jwksResponse struct {
	Keys []jwksKey `json:"keys"`
}

type jwksKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwtAuth struct {
	jwksURL    string
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	httpClient *http.Client
}

func newJWTAuth(jwksURL string) *jwtAuth {
	return &jwtAuth{
		jwksURL:    jwksURL,
		keys:       make(map[string]*rsa.PublicKey),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (a *jwtAuth) fetchKeys() error {
	resp, err := a.httpClient.Get(a.jwksURL)
	if err != nil {
		return fmt.Errorf("fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	var jwks jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return fmt.Errorf("decode JWKS: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey)
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" {
			continue
		}
		nBytes, err := base64URLDecode(k.N)
		if err != nil {
			continue
		}
		eBytes, err := base64URLDecode(k.E)
		if err != nil {
			continue
		}
		n := new(big.Int).SetBytes(nBytes)
		e := 0
		for _, b := range eBytes {
			e = e<<8 + int(b)
		}
		keys[k.Kid] = &rsa.PublicKey{N: n, E: e}
	}

	a.mu.Lock()
	a.keys = keys
	a.mu.Unlock()
	return nil
}

func base64URLDecode(s string) ([]byte, error) {
	// Add padding if missing
	switch len(s) % 4 {
	case 2:
		s += "=="
	case 3:
		s += "="
	}
	// Replace URL-safe characters
	s = strings.NewReplacer("-", "+", "_", "/").Replace(s)

	return decodeBase64(s)
}

func (a *jwtAuth) getKey(kid string) (*rsa.PublicKey, error) {
	a.mu.RLock()
	key, ok := a.keys[kid]
	a.mu.RUnlock()
	if ok {
		return key, nil
	}

	if err := a.fetchKeys(); err != nil {
		return nil, err
	}

	a.mu.RLock()
	key, ok = a.keys[kid]
	a.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown kid: %s", kid)
	}
	return key, nil
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func envOrDefault(key, def string) string {
	if v, ok := lookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

var lookupEnv = os.LookupEnv

var decodeBase64 = func(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}
