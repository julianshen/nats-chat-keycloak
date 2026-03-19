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
