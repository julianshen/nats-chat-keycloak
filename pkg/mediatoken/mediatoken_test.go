package mediatoken

import (
	"strings"
	"testing"
	"time"
)

func TestSign_Format(t *testing.T) {
	tok, err := Sign([]byte("secret"), Claims{
		Action: "upload", FileID: "f1", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT should have 3 parts, got %d", len(parts))
	}
	if parts[0] != jwtHeader {
		t.Fatalf("unexpected header: %s", parts[0])
	}
}

func TestVerify_Roundtrip(t *testing.T) {
	secret := []byte("test-secret")
	original := Claims{
		Action:      "download",
		FileID:      "file-42",
		Room:        "general",
		Username:    "alice",
		Filename:    "report.pdf",
		ContentType: "application/pdf",
		Exp:         time.Now().Add(5 * time.Minute).Unix(),
	}

	tok, err := Sign(secret, original)
	if err != nil {
		t.Fatal(err)
	}

	claims, err := Verify(secret, tok)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if claims.Action != original.Action {
		t.Fatalf("action: got %s, want %s", claims.Action, original.Action)
	}
	if claims.FileID != original.FileID {
		t.Fatalf("fileID: got %s, want %s", claims.FileID, original.FileID)
	}
	if claims.Room != original.Room {
		t.Fatalf("room: got %s, want %s", claims.Room, original.Room)
	}
	if claims.Username != original.Username {
		t.Fatalf("username: got %s, want %s", claims.Username, original.Username)
	}
	if claims.Filename != original.Filename {
		t.Fatalf("filename: got %s, want %s", claims.Filename, original.Filename)
	}
	if claims.ContentType != original.ContentType {
		t.Fatalf("contentType: got %s, want %s", claims.ContentType, original.ContentType)
	}
}

func TestVerify_Expired(t *testing.T) {
	tok, _ := Sign([]byte("s"), Claims{
		Action: "upload", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(-1 * time.Minute).Unix(),
	})
	_, err := Verify([]byte("s"), tok)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}

func TestVerify_WrongSecret(t *testing.T) {
	tok, _ := Sign([]byte("real"), Claims{
		Action: "upload", FileID: "f", Room: "r", Username: "u",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	})
	_, err := Verify([]byte("fake"), tok)
	if err == nil {
		t.Fatal("expected error for wrong secret")
	}
}

func TestVerify_Malformed(t *testing.T) {
	_, err := Verify([]byte("s"), "not.a.valid.jwt")
	if err == nil {
		t.Fatal("expected error for malformed token")
	}

	_, err = Verify([]byte("s"), "only-one-part")
	if err == nil {
		t.Fatal("expected error for single-part token")
	}
}
