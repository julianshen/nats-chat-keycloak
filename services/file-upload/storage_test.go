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
	err := s.Save(ctx, "test-id", bytes.NewReader(data), "text/plain")
	if err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify file exists on disk
	if _, err := os.Stat(filepath.Join(dir, "test-id")); err != nil {
		t.Fatalf("file not on disk: %v", err)
	}

	rc, err := s.Open(ctx, "test-id")
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer rc.Close()

	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll failed: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("got %q, want %q", got, data)
	}
}

func TestLocalStorage_Delete(t *testing.T) {
	dir := t.TempDir()
	s := NewLocalStorage(dir)
	ctx := context.Background()

	data := []byte("to be deleted")
	if err := s.Save(ctx, "del-id", bytes.NewReader(data), "text/plain"); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if err := s.Delete(ctx, "del-id"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	_, err := s.Open(ctx, "del-id")
	if err == nil {
		t.Fatal("expected error opening deleted file, got nil")
	}
}

func TestLocalStorage_OpenNonExistent(t *testing.T) {
	dir := t.TempDir()
	s := NewLocalStorage(dir)
	ctx := context.Background()

	_, err := s.Open(ctx, "no-such-id")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestLocalStorage_DeleteNonExistent(t *testing.T) {
	dir := t.TempDir()
	s := NewLocalStorage(dir)
	ctx := context.Background()

	err := s.Delete(ctx, "no-such-id")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestStorageInterface(t *testing.T) {
	// Compile-time check that LocalStorage implements Storage
	var _ Storage = (*LocalStorage)(nil)
}
