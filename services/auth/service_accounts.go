package main

import (
	"database/sql"
	"log/slog"
	"sync"
	"time"
)

// ServiceAccountCache loads service accounts from PostgreSQL into memory
// and refreshes periodically to pick up new accounts without restart.
type ServiceAccountCache struct {
	db       *sql.DB
	mu       sync.RWMutex
	accounts map[string]string // username -> password
	stopCh   chan struct{}
}

// NewServiceAccountCache creates a cache, loads initial data, and starts background refresh.
func NewServiceAccountCache(db *sql.DB) (*ServiceAccountCache, error) {
	c := &ServiceAccountCache{
		db:       db,
		accounts: make(map[string]string),
		stopCh:   make(chan struct{}),
	}
	if err := c.refresh(); err != nil {
		return nil, err
	}
	go c.refreshLoop()
	return c, nil
}

func (c *ServiceAccountCache) refresh() error {
	rows, err := c.db.Query("SELECT username, password FROM service_accounts")
	if err != nil {
		return err
	}
	defer rows.Close()

	accounts := make(map[string]string)
	for rows.Next() {
		var username, password string
		if err := rows.Scan(&username, &password); err != nil {
			return err
		}
		accounts[username] = password
	}

	c.mu.Lock()
	c.accounts = accounts
	c.mu.Unlock()

	slog.Info("Service accounts cache refreshed", "count", len(accounts))
	return nil
}

func (c *ServiceAccountCache) refreshLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := c.refresh(); err != nil {
				slog.Error("Failed to refresh service accounts", "error", err)
			}
		case <-c.stopCh:
			return
		}
	}
}

// Authenticate checks username/password against the cached accounts.
func (c *ServiceAccountCache) Authenticate(username, password string) bool {
	c.mu.RLock()
	cached, ok := c.accounts[username]
	c.mu.RUnlock()
	return ok && cached == password
}

// Close stops the background refresh goroutine.
func (c *ServiceAccountCache) Close() {
	close(c.stopCh)
}
