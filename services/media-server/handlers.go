package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// TokenClaims represents the claims in a media access token.
// Tokens are HMAC-SHA256 signed and short-lived.
type TokenClaims struct {
	Action      string `json:"act"`            // "upload" or "download"
	FileID      string `json:"fid"`            // target file ID
	Room        string `json:"room"`           // room the file belongs to
	Username    string `json:"sub"`            // user who requested access
	Filename    string `json:"name,omitempty"` // original filename (for download Content-Disposition)
	ContentType string `json:"ct,omitempty"`   // MIME type (for download Content-Type)
	Exp         int64  `json:"exp"`            // expiry (unix seconds)
}

// UploadResponse is returned after a successful upload.
type UploadResponse struct {
	ID   string `json:"id"`
	Size int64  `json:"size"`
}

// server holds the media server state.
type server struct {
	storage       Storage
	secret        []byte
	maxUploadSize int64
}

// signToken creates an HMAC-signed token string from claims.
func signToken(secret []byte, claims TokenClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal claims: %w", err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	sig := hex.EncodeToString(mac.Sum(nil))
	return hex.EncodeToString(payload) + "." + sig, nil
}

// verifyToken parses and verifies an HMAC-signed token.
func verifyToken(secret []byte, token string) (*TokenClaims, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("malformed token")
	}
	payload, err := hex.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	sig, err := hex.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, fmt.Errorf("invalid signature")
	}

	var claims TokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("unmarshal claims: %w", err)
	}
	if time.Now().Unix() > claims.Exp {
		return nil, fmt.Errorf("token expired")
	}
	return &claims, nil
}

func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	fileID := r.PathValue("id")
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	claims, err := verifyToken(s.secret, tokenStr)
	if err != nil {
		slog.Warn("Upload token rejected", "error", err)
		http.Error(w, "invalid or expired token", http.StatusUnauthorized)
		return
	}
	if claims.Action != "upload" {
		http.Error(w, "token action mismatch", http.StatusForbidden)
		return
	}
	if claims.FileID != fileID {
		http.Error(w, "token file ID mismatch", http.StatusForbidden)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, s.maxUploadSize)
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	if err := s.storage.Save(r.Context(), fileID, file, header.Header.Get("Content-Type")); err != nil {
		slog.Error("Failed to save file", "id", fileID, "error", err)
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(UploadResponse{ID: fileID, Size: header.Size})
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	fileID := r.PathValue("id")
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	claims, err := verifyToken(s.secret, tokenStr)
	if err != nil {
		slog.Warn("Download token rejected", "error", err)
		http.Error(w, "invalid or expired token", http.StatusUnauthorized)
		return
	}
	if claims.Action != "download" {
		http.Error(w, "token action mismatch", http.StatusForbidden)
		return
	}
	if claims.FileID != fileID {
		http.Error(w, "token file ID mismatch", http.StatusForbidden)
		return
	}

	rc, err := s.storage.Open(r.Context(), fileID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer rc.Close()

	if claims.ContentType != "" {
		w.Header().Set("Content-Type", claims.ContentType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	if claims.Filename != "" {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, claims.Filename))
	}
	io.Copy(w, rc)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	secret := envOrDefault("MEDIA_TOKEN_SECRET", "change-me-in-production")
	uploadDir := envOrDefault("UPLOAD_DIR", "/data/uploads")
	httpPort := envOrDefault("HTTP_PORT", "8095")
	maxUploadStr := envOrDefault("MAX_UPLOAD_SIZE", "52428800")

	maxUploadSize, err := strconv.ParseInt(maxUploadStr, 10, 64)
	if err != nil {
		maxUploadSize = 50 * 1024 * 1024
	}

	slog.Info("Starting Media Server", "port", httpPort, "upload_dir", uploadDir)

	s := &server{
		storage:       NewLocalStorage(uploadDir),
		secret:        []byte(secret),
		maxUploadSize: maxUploadSize,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /upload/{id}", s.handleUpload)
	mux.HandleFunc("GET /files/{id}", s.handleDownload)

	handler := corsMiddleware(mux)
	srv := &http.Server{Addr: ":" + httpPort, Handler: handler}

	slog.Info("Media server listening", "port", httpPort)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("Server error", "error", err)
		os.Exit(1)
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
