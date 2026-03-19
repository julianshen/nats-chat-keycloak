package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Storage is an abstract interface for blob storage.
// Implementations can target local filesystem, S3, GCS, Azure Blob, etc.
type Storage interface {
	Save(ctx context.Context, id string, reader io.Reader, contentType string) error
	Open(ctx context.Context, id string) (io.ReadCloser, error)
	Delete(ctx context.Context, id string) error
}

// LocalStorage stores files on the local filesystem.
type LocalStorage struct {
	dir string
}

func NewLocalStorage(dir string) *LocalStorage {
	absDir, _ := filepath.Abs(dir)
	return &LocalStorage{dir: absDir}
}

// safePath validates that the id does not escape the storage directory.
func (s *LocalStorage) safePath(id string) (string, error) {
	if id == "" || strings.ContainsAny(id, "/\\") || id == "." || id == ".." {
		return "", fmt.Errorf("invalid file ID: %q", id)
	}
	p := filepath.Join(s.dir, id)
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	if !strings.HasPrefix(abs, s.dir+string(filepath.Separator)) && abs != s.dir {
		return "", fmt.Errorf("path traversal blocked: %q", id)
	}
	return abs, nil
}

func (s *LocalStorage) Save(ctx context.Context, id string, reader io.Reader, contentType string) error {
	p, err := s.safePath(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return fmt.Errorf("create upload dir: %w", err)
	}
	f, err := os.Create(p)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	defer f.Close()
	if _, err := io.Copy(f, reader); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	return nil
}

func (s *LocalStorage) Open(ctx context.Context, id string) (io.ReadCloser, error) {
	p, err := s.safePath(id)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, fmt.Errorf("open file: %w", err)
	}
	return f, nil
}

func (s *LocalStorage) Delete(ctx context.Context, id string) error {
	p, err := s.safePath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil {
		return fmt.Errorf("delete file: %w", err)
	}
	return nil
}
