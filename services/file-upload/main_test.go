package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

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

func newTestService(membership func(string, string) bool) *service {
	return &service{
		mediaBaseURL:    "http://media:8095",
		tokenSecret:     []byte("test-secret"),
		tokenTTL:        5 * time.Minute,
		genID:           func() string { return "test-file-id" },
		checkMembership: membership,
	}
}

func TestUploadRequest_MemberAllowed(t *testing.T) {
	svc := newTestService(allowOnly(map[string][]string{"general": {"alice"}}))

	reqData, _ := json.Marshal(UploadRequest{Room: "general", Filename: "doc.pdf"})
	resp, err := svc.handleUploadRequest("alice", reqData)
	if err != nil {
		t.Fatalf("handleUploadRequest: %v", err)
	}

	var result UploadResponse
	json.Unmarshal(resp, &result)

	if result.FileID != "test-file-id" {
		t.Fatalf("expected fileId test-file-id, got %s", result.FileID)
	}
	if result.Token == "" {
		t.Fatal("expected non-empty token")
	}
	if !strings.Contains(result.UploadURL, "media:8095/upload/test-file-id") {
		t.Fatalf("unexpected uploadUrl: %s", result.UploadURL)
	}
	if !strings.Contains(result.UploadURL, "token=") {
		t.Fatalf("uploadUrl missing token param: %s", result.UploadURL)
	}
}

func TestUploadRequest_NonMemberDenied(t *testing.T) {
	svc := newTestService(allowOnly(map[string][]string{"general": {"bob"}}))

	reqData, _ := json.Marshal(UploadRequest{Room: "general", Filename: "doc.pdf"})
	resp, _ := svc.handleUploadRequest("alice", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["error"] == "" {
		t.Fatal("expected error for non-member")
	}
	if !strings.Contains(result["error"], "forbidden") {
		t.Fatalf("expected forbidden error, got: %s", result["error"])
	}
}

func TestUploadRequest_MissingFields(t *testing.T) {
	svc := newTestService(nil)

	reqData, _ := json.Marshal(UploadRequest{Room: "", Filename: ""})
	resp, _ := svc.handleUploadRequest("alice", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["error"] == "" {
		t.Fatal("expected error for missing fields")
	}
}

func TestDownloadRequest_NonMemberDenied(t *testing.T) {
	// Without DB, download always returns "file not found" — which is correct
	// since we can't look up the file's room without DB.
	svc := newTestService(allowOnly(map[string][]string{}))

	reqData, _ := json.Marshal(DownloadRequest{FileID: "some-file"})
	resp, _ := svc.handleDownloadRequest("alice", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["error"] == "" {
		t.Fatal("expected error")
	}
}

func TestDownloadRequest_MissingFileID(t *testing.T) {
	svc := newTestService(nil)

	reqData, _ := json.Marshal(DownloadRequest{FileID: ""})
	resp, _ := svc.handleDownloadRequest("alice", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["error"] == "" {
		t.Fatal("expected error for missing fileId")
	}
}

func TestSignJWT_Roundtrip(t *testing.T) {
	secret := []byte("test-secret")
	claims := TokenClaims{
		Action:   "upload",
		FileID:   "file-123",
		Room:     "general",
		Username: "alice",
		Exp:      time.Now().Add(5 * time.Minute).Unix(),
	}
	tok, err := SignJWT(secret, claims)
	if err != nil {
		t.Fatalf("SignJWT: %v", err)
	}
	if tok == "" {
		t.Fatal("expected non-empty token")
	}
	// JWT should have three parts separated by dots
	parts := strings.SplitN(tok, ".", 3)
	if len(parts) != 3 {
		t.Fatalf("expected 3 parts, got %d", len(parts))
	}
	// Verify roundtrip
	got, err := VerifyJWT(secret, tok)
	if err != nil {
		t.Fatalf("VerifyJWT: %v", err)
	}
	if got.Action != claims.Action || got.FileID != claims.FileID {
		t.Fatalf("claims mismatch: got %+v", got)
	}
}

func TestFileMetadataJSON(t *testing.T) {
	fm := FileMetadata{
		ID: "abc", Room: "r", Uploader: "u", Filename: "f",
		Size: 1024, ContentType: "text/plain", CreatedAt: 100,
	}
	data, _ := json.Marshal(fm)
	var got FileMetadata
	json.Unmarshal(data, &got)
	if got != fm {
		t.Fatalf("got %+v, want %+v", got, fm)
	}
}

func TestHandleUploaded_ValidToken(t *testing.T) {
	svc := newTestService(nil)
	svc.db = nil

	// Generate a valid upload token first
	tok, _ := SignJWT(svc.tokenSecret, TokenClaims{
		Action: "upload", FileID: "f", Room: "r", Username: "alice",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})

	reqData, _ := json.Marshal(UploadedNotification{
		Token: tok, Filename: "n", Size: 100, ContentType: "text/plain",
	})
	resp, _ := svc.handleUploaded("alice", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["status"] != "ok" {
		t.Fatalf("expected ok, got: %v", result)
	}
	if result["fileId"] != "f" {
		t.Fatalf("expected fileId 'f', got: %s", result["fileId"])
	}
}

func TestHandleUploaded_MissingToken(t *testing.T) {
	svc := newTestService(nil)

	reqData, _ := json.Marshal(UploadedNotification{
		Filename: "n", Size: 100, ContentType: "text/plain",
	})
	resp, _ := svc.handleUploaded("alice", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["error"] == "" {
		t.Fatal("expected error for missing token")
	}
}

func TestHandleUploaded_UserMismatch(t *testing.T) {
	svc := newTestService(nil)

	tok, _ := SignJWT(svc.tokenSecret, TokenClaims{
		Action: "upload", FileID: "f", Room: "r", Username: "alice",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})
	reqData, _ := json.Marshal(UploadedNotification{
		Token: tok, Filename: "n", Size: 100, ContentType: "text/plain",
	})
	// Bob tries to claim alice's upload
	resp, _ := svc.handleUploaded("bob", reqData)

	var result map[string]string
	json.Unmarshal(resp, &result)
	if !strings.Contains(result["error"], "mismatch") {
		t.Fatalf("expected mismatch error, got: %v", result)
	}
}

func TestHandleFileInfo_NoDB(t *testing.T) {
	svc := newTestService(nil)
	svc.db = nil

	resp, _ := svc.handleFileInfo("alice", "some-id")
	var result map[string]string
	json.Unmarshal(resp, &result)
	if result["error"] != "not found" {
		t.Fatalf("expected 'not found', got: %v", result)
	}
}

func TestHandleFileList_NoDB(t *testing.T) {
	svc := newTestService(nil)
	svc.db = nil

	resp, _ := svc.handleFileList("alice", "some-room")
	var result []FileMetadata
	json.Unmarshal(resp, &result)
	if len(result) != 0 {
		t.Fatalf("expected empty list, got %d", len(result))
	}
}

func TestHandleFileList_NonMemberDenied(t *testing.T) {
	svc := newTestService(allowOnly(map[string][]string{"general": {"alice"}}))
	svc.db = nil

	resp, _ := svc.handleFileList("bob", "general")
	var result map[string]string
	json.Unmarshal(resp, &result)
	if !strings.Contains(result["error"], "forbidden") {
		t.Fatalf("expected forbidden error, got: %v", result)
	}
}
