package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type memStorage struct {
	blobs map[string][]byte
}

func newMemStorage() *memStorage { return &memStorage{blobs: make(map[string][]byte)} }
func (m *memStorage) Save(_ context.Context, id string, r io.Reader, _ string) error {
	d, _ := io.ReadAll(r)
	m.blobs[id] = d
	return nil
}
func (m *memStorage) Open(_ context.Context, id string) (io.ReadCloser, error) {
	d, ok := m.blobs[id]
	if !ok {
		return nil, io.ErrUnexpectedEOF
	}
	return io.NopCloser(bytes.NewReader(d)), nil
}
func (m *memStorage) Delete(_ context.Context, id string) error {
	delete(m.blobs, id)
	return nil
}

func makeToken(t *testing.T, secret string, claims TokenClaims) string {
	t.Helper()
	tok, err := signToken([]byte(secret), claims)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}
	return tok
}

func TestUpload_ValidToken(t *testing.T) {
	store := newMemStorage()
	s := &server{storage: store, secret: []byte("test-secret"), maxUploadSize: 50 * 1024 * 1024}

	token := makeToken(t, "test-secret", TokenClaims{
		Action:   "upload",
		FileID:   "file-001",
		Room:     "general",
		Username: "alice",
		Exp:      time.Now().Add(5 * time.Minute).Unix(),
	})

	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	part, _ := w.CreateFormFile("file", "test.txt")
	part.Write([]byte("hello world"))
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload/file-001?token="+token, body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.SetPathValue("id", "file-001")

	rr := httptest.NewRecorder()
	s.handleUpload(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if _, ok := store.blobs["file-001"]; !ok {
		t.Fatal("blob not stored")
	}

	var resp UploadResponse
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp.ID != "file-001" {
		t.Fatalf("expected id file-001, got %s", resp.ID)
	}
}

func TestUpload_ExpiredToken(t *testing.T) {
	s := &server{storage: newMemStorage(), secret: []byte("s"), maxUploadSize: 50 * 1024 * 1024}

	token := makeToken(t, "s", TokenClaims{
		Action: "upload", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(-1 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodPost, "/upload/f?token="+token, nil)
	req.SetPathValue("id", "f")
	rr := httptest.NewRecorder()
	s.handleUpload(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestUpload_WrongAction(t *testing.T) {
	s := &server{storage: newMemStorage(), secret: []byte("s"), maxUploadSize: 50 * 1024 * 1024}

	token := makeToken(t, "s", TokenClaims{
		Action: "download", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodPost, "/upload/f?token="+token, nil)
	req.SetPathValue("id", "f")
	rr := httptest.NewRecorder()
	s.handleUpload(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rr.Code)
	}
}

func TestUpload_WrongFileID(t *testing.T) {
	s := &server{storage: newMemStorage(), secret: []byte("s"), maxUploadSize: 50 * 1024 * 1024}

	token := makeToken(t, "s", TokenClaims{
		Action: "upload", FileID: "file-A", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodPost, "/upload/file-B?token="+token, nil)
	req.SetPathValue("id", "file-B")
	rr := httptest.NewRecorder()
	s.handleUpload(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rr.Code)
	}
}

func TestUpload_WrongSecret(t *testing.T) {
	s := &server{storage: newMemStorage(), secret: []byte("real-secret"), maxUploadSize: 50 * 1024 * 1024}

	token := makeToken(t, "wrong-secret", TokenClaims{
		Action: "upload", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodPost, "/upload/f?token="+token, nil)
	req.SetPathValue("id", "f")
	rr := httptest.NewRecorder()
	s.handleUpload(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestUpload_MissingToken(t *testing.T) {
	s := &server{storage: newMemStorage(), secret: []byte("s"), maxUploadSize: 50 * 1024 * 1024}

	req := httptest.NewRequest(http.MethodPost, "/upload/f", nil)
	req.SetPathValue("id", "f")
	rr := httptest.NewRecorder()
	s.handleUpload(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestDownload_ValidToken(t *testing.T) {
	store := newMemStorage()
	store.blobs["file-001"] = []byte("file content")
	s := &server{storage: store, secret: []byte("test-secret")}

	token := makeToken(t, "test-secret", TokenClaims{
		Action:      "download",
		FileID:      "file-001",
		Room:        "general",
		Username:    "alice",
		Filename:    "report.pdf",
		ContentType: "application/pdf",
		Exp:         time.Now().Add(5 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, "/files/file-001?token="+token, nil)
	req.SetPathValue("id", "file-001")
	rr := httptest.NewRecorder()
	s.handleDownload(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if rr.Body.String() != "file content" {
		t.Fatalf("body mismatch")
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Fatalf("expected application/pdf, got %s", ct)
	}
	if cd := rr.Header().Get("Content-Disposition"); cd != `attachment; filename="report.pdf"` {
		t.Fatalf("unexpected Content-Disposition: %s", cd)
	}
}

func TestDownload_ExpiredToken(t *testing.T) {
	store := newMemStorage()
	store.blobs["f"] = []byte("x")
	s := &server{storage: store, secret: []byte("s")}

	token := makeToken(t, "s", TokenClaims{
		Action: "download", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(-1 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, "/files/f?token="+token, nil)
	req.SetPathValue("id", "f")
	rr := httptest.NewRecorder()
	s.handleDownload(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestDownload_WrongAction(t *testing.T) {
	store := newMemStorage()
	store.blobs["f"] = []byte("x")
	s := &server{storage: store, secret: []byte("s")}

	token := makeToken(t, "s", TokenClaims{
		Action: "upload", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, "/files/f?token="+token, nil)
	req.SetPathValue("id", "f")
	rr := httptest.NewRecorder()
	s.handleDownload(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rr.Code)
	}
}

func TestDownload_BlobNotFound(t *testing.T) {
	s := &server{storage: newMemStorage(), secret: []byte("s")}

	token := makeToken(t, "s", TokenClaims{
		Action: "download", FileID: "missing", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, "/files/missing?token="+token, nil)
	req.SetPathValue("id", "missing")
	rr := httptest.NewRecorder()
	s.handleDownload(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}
