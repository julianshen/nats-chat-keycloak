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
)

// mockStorage is a test double for Storage.
type mockStorage struct {
	blobs map[string][]byte
}

func newMockStorage() *mockStorage {
	return &mockStorage{blobs: make(map[string][]byte)}
}

func (m *mockStorage) Save(_ context.Context, id string, r io.Reader, _ string) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.blobs[id] = data
	return nil
}

func (m *mockStorage) Open(_ context.Context, id string) (io.ReadCloser, error) {
	data, ok := m.blobs[id]
	if !ok {
		return nil, io.ErrUnexpectedEOF
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (m *mockStorage) Delete(_ context.Context, id string) error {
	delete(m.blobs, id)
	return nil
}

// allowAll returns a membership checker that always allows access.
func allowAll() func(string, string) bool {
	return func(room, username string) bool { return true }
}

// denyAll returns a membership checker that always denies access.
func denyAll() func(string, string) bool {
	return func(room, username string) bool { return false }
}

// allowOnly returns a membership checker that allows specific user+room pairs.
func allowOnly(allowed map[string][]string) func(string, string) bool {
	return func(room, username string) bool {
		for _, u := range allowed[room] {
			if u == username {
				return true
			}
		}
		return false
	}
}

func TestUploadHandler_Success(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		maxUploadSize:   50 * 1024 * 1024,
		checkMembership: allowAll(),
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("room", "general")
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("file content here"))
	writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))

	rr := httptest.NewRecorder()
	h.handleUpload(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp FileMetadata
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Filename != "test.txt" {
		t.Fatalf("expected filename test.txt, got %s", resp.Filename)
	}
	if resp.Room != "general" {
		t.Fatalf("expected room general, got %s", resp.Room)
	}
	if resp.Uploader != "alice" {
		t.Fatalf("expected uploader alice, got %s", resp.Uploader)
	}
	if resp.Size != int64(len("file content here")) {
		t.Fatalf("expected size %d, got %d", len("file content here"), resp.Size)
	}

	// Verify blob was stored
	if _, ok := store.blobs[resp.ID]; !ok {
		t.Fatal("file not saved to storage")
	}
}

func TestUploadHandler_NonMemberDenied(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		maxUploadSize:   50 * 1024 * 1024,
		checkMembership: allowOnly(map[string][]string{"general": {"bob"}}),
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("room", "general")
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("file content here"))
	writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))

	rr := httptest.NewRecorder()
	h.handleUpload(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rr.Code, rr.Body.String())
	}

	// Verify no blob was stored
	if len(store.blobs) != 0 {
		t.Fatal("file should not have been saved")
	}
}

func TestUploadHandler_MemberAllowed(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		maxUploadSize:   50 * 1024 * 1024,
		checkMembership: allowOnly(map[string][]string{"secret-room": {"alice"}}),
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("room", "secret-room")
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("data"))
	writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))

	rr := httptest.NewRecorder()
	h.handleUpload(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestUploadHandler_MissingRoom(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		maxUploadSize:   50 * 1024 * 1024,
		checkMembership: allowAll(),
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("data"))
	writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))

	rr := httptest.NewRecorder()
	h.handleUpload(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestUploadHandler_MissingFile(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		maxUploadSize:   50 * 1024 * 1024,
		checkMembership: allowAll(),
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("room", "general")
	writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))

	rr := httptest.NewRecorder()
	h.handleUpload(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestDownloadHandler_Success(t *testing.T) {
	store := newMockStorage()
	store.blobs["file-123"] = []byte("download me")

	h := &handlers{
		storage:         store,
		checkMembership: allowAll(),
	}

	h.filesMu.Lock()
	h.files = map[string]FileMetadata{
		"file-123": {
			ID:          "file-123",
			Room:        "general",
			Uploader:    "alice",
			Filename:    "test.txt",
			Size:        11,
			ContentType: "text/plain",
		},
	}
	h.filesMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/files/file-123", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))
	req.SetPathValue("id", "file-123")

	rr := httptest.NewRecorder()
	h.handleDownload(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if rr.Body.String() != "download me" {
		t.Fatalf("expected 'download me', got %q", rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "text/plain" {
		t.Fatalf("expected Content-Type text/plain, got %s", ct)
	}
}

func TestDownloadHandler_NonMemberDenied(t *testing.T) {
	store := newMockStorage()
	store.blobs["file-123"] = []byte("secret data")

	h := &handlers{
		storage:         store,
		checkMembership: allowOnly(map[string][]string{"secret-room": {"alice"}}),
	}

	h.filesMu.Lock()
	h.files = map[string]FileMetadata{
		"file-123": {
			ID:          "file-123",
			Room:        "secret-room",
			Uploader:    "alice",
			Filename:    "secret.txt",
			Size:        11,
			ContentType: "text/plain",
		},
	}
	h.filesMu.Unlock()

	// bob is NOT a member of secret-room
	req := httptest.NewRequest(http.MethodGet, "/files/file-123", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "bob"))
	req.SetPathValue("id", "file-123")

	rr := httptest.NewRecorder()
	h.handleDownload(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDownloadHandler_MemberOfDifferentRoom(t *testing.T) {
	store := newMockStorage()
	store.blobs["file-456"] = []byte("private data")

	h := &handlers{
		storage: store,
		// alice is in "general" but NOT in "private-room"
		checkMembership: allowOnly(map[string][]string{"general": {"alice"}}),
	}

	h.filesMu.Lock()
	h.files = map[string]FileMetadata{
		"file-456": {
			ID:          "file-456",
			Room:        "private-room",
			Uploader:    "bob",
			Filename:    "private.txt",
			Size:        12,
			ContentType: "text/plain",
		},
	}
	h.filesMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/files/file-456", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))
	req.SetPathValue("id", "file-456")

	rr := httptest.NewRecorder()
	h.handleDownload(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDownloadHandler_NotFound(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		files:           map[string]FileMetadata{},
		checkMembership: allowAll(),
	}

	req := httptest.NewRequest(http.MethodGet, "/files/nonexistent", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxUsernameKey, "alice"))
	req.SetPathValue("id", "nonexistent")

	rr := httptest.NewRecorder()
	h.handleDownload(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestDownloadHandler_Unauthorized(t *testing.T) {
	store := newMockStorage()
	h := &handlers{
		storage:         store,
		files:           map[string]FileMetadata{},
		checkMembership: allowAll(),
	}

	// No username in context
	req := httptest.NewRequest(http.MethodGet, "/files/file-123", nil)
	req.SetPathValue("id", "file-123")

	rr := httptest.NewRecorder()
	h.handleDownload(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestFileMetadataJSON(t *testing.T) {
	fm := FileMetadata{
		ID:          "abc-123",
		Room:        "general",
		Uploader:    "bob",
		Filename:    "photo.png",
		Size:        1024,
		ContentType: "image/png",
		CreatedAt:   1700000000,
	}
	data, err := json.Marshal(fm)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got FileMetadata
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got != fm {
		t.Fatalf("got %+v, want %+v", got, fm)
	}
}
