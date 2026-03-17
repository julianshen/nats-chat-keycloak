package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/jwt/v2"
)

// PermissionsConfig represents the JSON config for role-to-subject mapping.
type PermissionsConfig struct {
	Admin   RolePermissions `json:"admin"`
	User    RolePermissions `json:"user"`
	None    RolePermissions `json:"none"`
	E2EEPub []string        `json:"e2ee_pub"`
	E2EESub []string        `json:"e2ee_sub"`
	Resp    RespConfig      `json:"resp"`
}

// RolePermissions defines pub/sub subjects for a role.
type RolePermissions struct {
	Pub []string `json:"pub"`
	Sub []string `json:"sub"`
}

// RespConfig defines response permission settings.
type RespConfig struct {
	MaxMsgs   int   `json:"maxMsgs"`
	ExpiresNs int64 `json:"expiresNs"`
}

// PermissionsStore holds the loaded permissions config with thread-safe reload.
type PermissionsStore struct {
	mu     sync.RWMutex
	config PermissionsConfig
	path   string
}

// LoadPermissionsConfig reads and parses a permissions JSON file.
func LoadPermissionsConfig(path string) (PermissionsConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return PermissionsConfig{}, fmt.Errorf("read permissions config: %w", err)
	}
	var cfg PermissionsConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return PermissionsConfig{}, fmt.Errorf("parse permissions config: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return PermissionsConfig{}, fmt.Errorf("invalid permissions config: %w", err)
	}
	return cfg, nil
}

// validate checks that the config has minimum required content.
func (c PermissionsConfig) validate() error {
	if len(c.Admin.Pub) == 0 {
		return fmt.Errorf("admin pub subjects are empty")
	}
	if len(c.Admin.Sub) == 0 {
		return fmt.Errorf("admin sub subjects are empty")
	}
	if len(c.User.Pub) == 0 {
		return fmt.Errorf("user pub subjects are empty")
	}
	if len(c.User.Sub) == 0 {
		return fmt.Errorf("user sub subjects are empty")
	}
	if len(c.None.Pub) == 0 {
		return fmt.Errorf("none pub subjects are empty")
	}
	if len(c.None.Sub) == 0 {
		return fmt.Errorf("none sub subjects are empty")
	}
	if c.Resp.MaxMsgs <= 0 {
		return fmt.Errorf("resp.maxMsgs must be positive, got %d", c.Resp.MaxMsgs)
	}
	return nil
}

// NewPermissionsStore creates a store loaded from the given config file path.
func NewPermissionsStore(path string) (*PermissionsStore, error) {
	cfg, err := LoadPermissionsConfig(path)
	if err != nil {
		return nil, err
	}
	return &PermissionsStore{config: cfg, path: path}, nil
}

// Reload re-reads the config file. Returns error if reload fails (keeps old config).
func (ps *PermissionsStore) Reload() error {
	cfg, err := LoadPermissionsConfig(ps.path)
	if err != nil {
		return err
	}
	ps.mu.Lock()
	ps.config = cfg
	ps.mu.Unlock()
	slog.Info("Permissions config reloaded", "path", ps.path)
	return nil
}

// Config returns a snapshot of the current config.
func (ps *PermissionsStore) Config() PermissionsConfig {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return ps.config
}

// expandSubjects replaces {username} placeholders in a subject list.
func expandSubjects(subjects []string, username string) jwt.StringList {
	result := make(jwt.StringList, len(subjects))
	for i, s := range subjects {
		result[i] = strings.ReplaceAll(s, "{username}", username)
	}
	return result
}

// mapPermissions converts Keycloak realm roles into NATS permissions
// using the given PermissionsConfig.
func mapPermissions(cfg PermissionsConfig, roles []string, username string) jwt.Permissions {
	perms := jwt.Permissions{
		Pub: jwt.Permission{},
		Sub: jwt.Permission{},
	}

	roleSet := make(map[string]bool)
	for _, r := range roles {
		roleSet[r] = true
	}

	var roleCfg RolePermissions
	switch {
	case roleSet["admin"]:
		roleCfg = cfg.Admin
	case roleSet["user"]:
		roleCfg = cfg.User
	default:
		roleCfg = cfg.None
	}

	perms.Pub.Allow = expandSubjects(roleCfg.Pub, username)
	perms.Sub.Allow = expandSubjects(roleCfg.Sub, username)

	// Append e2ee permissions for admin and user roles (not "none")
	if roleSet["admin"] || roleSet["user"] {
		perms.Pub.Allow = append(perms.Pub.Allow, expandSubjects(cfg.E2EEPub, username)...)
		perms.Sub.Allow = append(perms.Sub.Allow, expandSubjects(cfg.E2EESub, username)...)
	}

	resp := &jwt.ResponsePermission{
		MaxMsgs: cfg.Resp.MaxMsgs,
		Expires: time.Duration(cfg.Resp.ExpiresNs),
	}
	perms.Resp = resp

	return perms
}

// servicePermissions returns broad permissions for backend service accounts.
// All services run in the CHAT account and need full pub/sub access.
func servicePermissions() jwt.Permissions {
	return jwt.Permissions{
		Pub: jwt.Permission{Allow: jwt.StringList{">"}},
		Sub: jwt.Permission{Allow: jwt.StringList{">"}},
		Resp: &jwt.ResponsePermission{
			MaxMsgs: -1,
			Expires: 5 * 60 * 1000000000, // 5 minutes in nanoseconds
		},
	}
}
