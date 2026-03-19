package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalStorage_SaveAndOpen(t *testing.T) {
	dir := t.TempDir()
	s := NewLocalStorage(dir)
	ctx := context.Background()

	data := []byte("hello world")
	if err := s.Save(ctx, "test-id", bytes.NewReader(data), "text/plain"); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "test-id")); err != nil {
		t.Fatalf("file not on disk: %v", err)
	}

	rc, err := s.Open(ctx, "test-id")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rc.Close()

	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, data) {
		t.Fatalf("got %q, want %q", got, data)
	}
}

func TestLocalStorage_Delete(t *testing.T) {
	dir := t.TempDir()
	s := NewLocalStorage(dir)
	ctx := context.Background()

	s.Save(ctx, "del-id", bytes.NewReader([]byte("x")), "text/plain")
	if err := s.Delete(ctx, "del-id"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Open(ctx, "del-id"); err == nil {
		t.Fatal("expected error opening deleted file")
	}
}

func TestLocalStorage_OpenNonExistent(t *testing.T) {
	s := NewLocalStorage(t.TempDir())
	if _, err := s.Open(context.Background(), "nope"); err == nil {
		t.Fatal("expected error")
	}
}

func TestStorageInterface(t *testing.T) {
	var _ Storage = (*LocalStorage)(nil)
}

func TestLocalStorage_PathTraversal(t *testing.T) {
	s := NewLocalStorage(t.TempDir())
	ctx := context.Background()

	malicious := []string{
		"../../../etc/passwd",
		"../secret",
		"foo/../../bar",
		"/etc/passwd",
		"..",
		".",
		"",
	}
	for _, id := range malicious {
		if err := s.Save(ctx, id, bytes.NewReader([]byte("x")), "text/plain"); err == nil {
			t.Errorf("Save(%q) should have failed", id)
		}
		if _, err := s.Open(ctx, id); err == nil {
			t.Errorf("Open(%q) should have failed", id)
		}
		if err := s.Delete(ctx, id); err == nil {
			t.Errorf("Delete(%q) should have failed", id)
		}
	}
}

func TestLocalStorage_ValidUUID(t *testing.T) {
	s := NewLocalStorage(t.TempDir())
	ctx := context.Background()

	// UUID-like IDs should work fine
	id := "550e8400-e29b-41d4-a716-446655440000"
	if err := s.Save(ctx, id, bytes.NewReader([]byte("ok")), "text/plain"); err != nil {
		t.Fatalf("Save valid UUID: %v", err)
	}
	rc, err := s.Open(ctx, id)
	if err != nil {
		t.Fatalf("Open valid UUID: %v", err)
	}
	rc.Close()
}
