package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nats-io/jwt/v2"
)

func containsSubject(subjects jwt.StringList, target string) bool {
	for _, s := range subjects {
		if s == target {
			return true
		}
	}
	return false
}

// loadTestConfig loads the permissions.json from the same directory as the test.
func loadTestConfig(t *testing.T) PermissionsConfig {
	t.Helper()
	cfg, err := LoadPermissionsConfig("permissions.json")
	if err != nil {
		t.Fatalf("failed to load permissions.json: %v", err)
	}
	return cfg
}

func TestLoadPermissionsConfig(t *testing.T) {
	cfg := loadTestConfig(t)

	// admin should have admin.> in pub
	if !containsSubject(cfg.Admin.Pub, "admin.>") {
		t.Error("admin pub should contain admin.>")
	}
	// user should NOT have admin.> in pub
	if containsSubject(cfg.User.Pub, "admin.>") {
		t.Error("user pub should not contain admin.>")
	}
	// none should not have deliver.{username}.send.>
	if containsSubject(cfg.None.Pub, "deliver.{username}.send.>") {
		t.Error("none pub should not contain deliver.{username}.send.>")
	}
	// e2ee lists should be non-empty
	if len(cfg.E2EEPub) == 0 {
		t.Error("e2ee_pub should not be empty")
	}
	if len(cfg.E2EESub) == 0 {
		t.Error("e2ee_sub should not be empty")
	}
	// resp config
	if cfg.Resp.MaxMsgs != 1 {
		t.Errorf("expected resp.maxMsgs = 1, got %d", cfg.Resp.MaxMsgs)
	}
	if cfg.Resp.ExpiresNs != 300000000000 {
		t.Errorf("expected resp.expiresNs = 300000000000, got %d", cfg.Resp.ExpiresNs)
	}
}

func TestLoadPermissionsConfig_InvalidPath(t *testing.T) {
	_, err := LoadPermissionsConfig("/nonexistent/path.json")
	if err == nil {
		t.Error("expected error for nonexistent file")
	}
}

func TestLoadPermissionsConfig_InvalidJSON(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(tmp, []byte("{invalid json"), 0644)
	_, err := LoadPermissionsConfig(tmp)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestLoadPermissionsConfig_EmptyConfig(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "empty.json")
	os.WriteFile(tmp, []byte("{}"), 0644)
	_, err := LoadPermissionsConfig(tmp)
	if err == nil {
		t.Error("expected validation error for empty config")
	}
}

func TestPermissionsConfig_Validate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     PermissionsConfig
		wantErr bool
	}{
		{
			name:    "empty config fails",
			cfg:     PermissionsConfig{},
			wantErr: true,
		},
		{
			name: "missing admin sub fails",
			cfg: PermissionsConfig{
				Admin: RolePermissions{Pub: []string{"a"}},
				User:  RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				None:  RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				Resp:  RespConfig{MaxMsgs: 1, ExpiresNs: 300000000000},
			},
			wantErr: true,
		},
		{
			name: "zero maxMsgs fails",
			cfg: PermissionsConfig{
				Admin: RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				User:  RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				None:  RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				Resp:  RespConfig{MaxMsgs: 0, ExpiresNs: 300000000000},
			},
			wantErr: true,
		},
		{
			name: "valid minimal config passes",
			cfg: PermissionsConfig{
				Admin: RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				User:  RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				None:  RolePermissions{Pub: []string{"a"}, Sub: []string{"b"}},
				Resp:  RespConfig{MaxMsgs: 1, ExpiresNs: 300000000000},
			},
			wantErr: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("validate() error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

func TestExpandSubjects(t *testing.T) {
	subjects := []string{"deliver.{username}.>", "admin.>", "{username}.inbox"}
	result := expandSubjects(subjects, "alice")
	expected := jwt.StringList{"deliver.alice.>", "admin.>", "alice.inbox"}
	for i, s := range expected {
		if result[i] != s {
			t.Errorf("index %d: expected %q, got %q", i, s, result[i])
		}
	}
}

func TestMapPermissions(t *testing.T) {
	cfg := loadTestConfig(t)

	tests := []struct {
		name         string
		roles        []string
		username     string
		wantPubAllow []string
		wantPubDeny  []string
		wantSubAllow []string
		wantResp     bool
	}{
		{
			name:     "admin and user roles",
			roles:    []string{"admin", "user"},
			username: "alice",
			wantPubAllow: []string{
				"deliver.alice.send.>",
				"admin.>",
				"chat.history.>",
				"room.create",
				"e2ee.identity.publish.alice",
				"apps.install.*",
			},
			wantSubAllow: []string{
				"deliver.alice.>",
				"room.notify.*",
				"room.presence.*",
				"_INBOX.>",
				"e2ee.roomkey.request.>",
			},
			wantResp: true,
		},
		{
			name:     "user role only",
			roles:    []string{"user"},
			username: "bob",
			wantPubAllow: []string{
				"deliver.bob.send.>",
				"chat.history.>",
				"room.create",
				"e2ee.identity.publish.bob",
			},
			wantPubDeny: []string{
				"admin.>",
			},
			wantSubAllow: []string{
				"deliver.bob.>",
				"room.notify.*",
			},
			wantResp: true,
		},
		{
			name:     "no roles - restricted",
			roles:    []string{},
			username: "charlie",
			wantPubAllow: []string{
				"chat.history.>",
				"msg.get",
				"room.join.*",
				"presence.update",
				"e2ee.identity.publish.charlie",
			},
			wantPubDeny: []string{
				"deliver.charlie.send.>",
				"admin.>",
				"room.create",
				"apps.install.*",
				"apps.uninstall.*",
				"e2ee.roomkey.distribute.charlie",
				"e2ee.roomkey.raw.pub.charlie",
			},
			wantSubAllow: []string{
				"deliver.charlie.>",
				"room.notify.*",
			},
			wantResp: true,
		},
		{
			name:     "admin without user role",
			roles:    []string{"admin"},
			username: "diana",
			wantPubAllow: []string{
				"deliver.diana.send.>",
				"admin.>",
				"room.create",
			},
			wantResp: true,
		},
		{
			name:     "unknown roles ignored",
			roles:    []string{"user", "unknown-role"},
			username: "eve",
			wantPubAllow: []string{
				"deliver.eve.send.>",
				"room.create",
			},
			wantPubDeny: []string{
				"admin.>",
			},
			wantResp: true,
		},
		{
			name:     "username with dots",
			roles:    []string{"user"},
			username: "user.name",
			wantPubAllow: []string{
				"deliver.user.name.send.>",
			},
			wantSubAllow: []string{
				"deliver.user.name.>",
			},
			wantResp: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			perms := mapPermissions(cfg, tt.roles, tt.username)

			for _, s := range tt.wantPubAllow {
				if !containsSubject(perms.Pub.Allow, s) {
					t.Errorf("Pub.Allow missing %q", s)
				}
			}
			for _, s := range tt.wantPubDeny {
				if containsSubject(perms.Pub.Allow, s) {
					t.Errorf("Pub.Allow should not contain %q", s)
				}
			}
			for _, s := range tt.wantSubAllow {
				if !containsSubject(perms.Sub.Allow, s) {
					t.Errorf("Sub.Allow missing %q", s)
				}
			}
			if tt.wantResp && perms.Resp == nil {
				t.Error("expected Resp to be non-nil")
			}
			if perms.Resp != nil && int64(perms.Resp.Expires) != cfg.Resp.ExpiresNs {
				t.Errorf("expected Resp.Expires = %d, got %d", cfg.Resp.ExpiresNs, perms.Resp.Expires)
			}
		})
	}
}

func TestServicePermissions(t *testing.T) {
	perms := servicePermissions()

	if !containsSubject(perms.Pub.Allow, ">") {
		t.Error("service perms should allow publish on >")
	}
	if !containsSubject(perms.Sub.Allow, ">") {
		t.Error("service perms should allow subscribe on >")
	}
	if perms.Resp == nil {
		t.Fatal("service perms should have Resp")
	}
	if perms.Resp.MaxMsgs != -1 {
		t.Errorf("expected MaxMsgs = -1, got %d", perms.Resp.MaxMsgs)
	}
	if perms.Resp.Expires != 5*60*1000000000 {
		t.Errorf("expected Resp.Expires = 5min in ns, got %d", perms.Resp.Expires)
	}
}

func TestPermissionsStore_Reload(t *testing.T) {
	// Copy the config to a temp dir so we can modify it
	tmp := filepath.Join(t.TempDir(), "permissions.json")
	data, err := os.ReadFile("permissions.json")
	if err != nil {
		t.Fatalf("failed to read permissions.json: %v", err)
	}
	os.WriteFile(tmp, data, 0644)

	store, err := NewPermissionsStore(tmp)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	cfg1 := store.Config()
	if !containsSubject(cfg1.Admin.Pub, "admin.>") {
		t.Error("initial config should have admin.>")
	}

	// Reload should succeed with same file
	if err := store.Reload(); err != nil {
		t.Fatalf("reload failed: %v", err)
	}

	cfg2 := store.Config()
	if !containsSubject(cfg2.Admin.Pub, "admin.>") {
		t.Error("reloaded config should still have admin.>")
	}
}

func TestPermissionsStore_ReloadKeepsOldOnError(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "permissions.json")
	data, err := os.ReadFile("permissions.json")
	if err != nil {
		t.Fatalf("failed to read permissions.json: %v", err)
	}
	os.WriteFile(tmp, data, 0644)

	store, err := NewPermissionsStore(tmp)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	// Corrupt the file
	os.WriteFile(tmp, []byte("{invalid"), 0644)

	// Reload should fail but keep old config
	if err := store.Reload(); err == nil {
		t.Error("expected reload error for corrupt file")
	}

	cfg := store.Config()
	if !containsSubject(cfg.Admin.Pub, "admin.>") {
		t.Error("config should be preserved after failed reload")
	}
}

func TestAdminHasExclusiveSubjects(t *testing.T) {
	cfg := loadTestConfig(t)

	// admin.> should be in admin but not in user or none
	if !containsSubject(cfg.Admin.Pub, "admin.>") {
		t.Error("admin pub should contain admin.>")
	}
	if containsSubject(cfg.User.Pub, "admin.>") {
		t.Error("user pub should not contain admin.>")
	}
	if containsSubject(cfg.None.Pub, "admin.>") {
		t.Error("none pub should not contain admin.>")
	}
}
