package main

import "testing"

func TestServiceAccountCache_Authenticate(t *testing.T) {
	cache := &ServiceAccountCache{
		accounts: map[string]string{
			"persist-worker":  "persist-secret",
			"history-service": "history-secret",
		},
	}

	tests := []struct {
		name     string
		username string
		password string
		want     bool
	}{
		{"correct credentials", "persist-worker", "persist-secret", true},
		{"wrong password", "persist-worker", "wrong-pass", false},
		{"missing user", "unknown-service", "any-pass", false},
		{"empty password", "persist-worker", "", false},
		{"case sensitive password", "persist-worker", "Persist-secret", false},
		{"empty username", "", "persist-secret", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cache.Authenticate(tt.username, tt.password)
			if got != tt.want {
				t.Errorf("Authenticate(%q, %q) = %v, want %v", tt.username, tt.password, got, tt.want)
			}
		})
	}
}
