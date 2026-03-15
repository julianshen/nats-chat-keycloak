package main

import (
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

func TestMapPermissions(t *testing.T) {
	tests := []struct {
		name           string
		roles          []string
		username       string
		wantPubAllow   []string
		wantPubDeny    []string
		wantSubAllow   []string
		wantResp       bool
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
				"e2ee.identity.publish",
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
				"e2ee.identity.publish",
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
				"e2ee.identity.publish",
			},
			wantPubDeny: []string{
				"deliver.charlie.send.>",
				"admin.>",
				"room.create",
				"apps.install.*",
				"apps.uninstall.*",
				"e2ee.roomkey.distribute",
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
			perms := mapPermissions(tt.roles, tt.username)

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
			if perms.Resp != nil && perms.Resp.Expires != 5*60*1000000000 {
				t.Errorf("expected Resp.Expires = 5min in ns, got %d", perms.Resp.Expires)
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
