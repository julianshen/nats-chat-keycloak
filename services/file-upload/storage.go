package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Storage is an abstract interface for blob storage.
// Implementations can target local filesystem, S3, GCS, Azure Blob, etc.
type Storage interface {
	// Save writes the content from reader to storage under the given id.
	Save(ctx context.Context, id string, reader io.Reader, contentType string) error
	// Open returns a ReadCloser for the stored blob. Caller must close it.
	Open(ctx context.Context, id string) (io.ReadCloser, error)
	// Delete removes the blob from storage.
	Delete(ctx context.Context, id string) error
}

// LocalStorage stores files on the local filesystem.
type LocalStorage struct {
	dir string
}

func NewLocalStorage(dir string) *LocalStorage {
	return &LocalStorage{dir: dir}
}

func (s *LocalStorage) Save(ctx context.Context, id string, reader io.Reader, contentType string) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return fmt.Errorf("create upload dir: %w", err)
	}
	f, err := os.Create(filepath.Join(s.dir, id))
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
	f, err := os.Open(filepath.Join(s.dir, id))
	if err != nil {
		return nil, fmt.Errorf("open file: %w", err)
	}
	return f, nil
}

func (s *LocalStorage) Delete(ctx context.Context, id string) error {
	err := os.Remove(filepath.Join(s.dir, id))
	if err != nil {
		return fmt.Errorf("delete file: %w", err)
	}
	return nil
}
