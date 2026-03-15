# Test Suite Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit tests for pure business logic in auth-service, fanout-service, room-service, and persist-worker.

**Architecture:** Each test file lives alongside source code in `package main`, uses Go's standard `testing` package with table-driven subtests (`t.Run`), and requires zero I/O (no NATS, no PostgreSQL). All tests must pass with `-race` flag.

**Tech Stack:** Go standard library `testing`, `crypto/aes`, `crypto/cipher`, `crypto/rand`, `encoding/base64`, `sync`, `sync/atomic`

**Spec:** `docs/superpowers/specs/2026-03-15-test-suite-design.md`

---

## Chunk 1: auth-service tests

### Task 1: Auth permissions tests

**Files:**
- Create: `auth-service/permissions_test.go`
- Reference: `auth-service/permissions.go:36-195`

- [ ] **Step 1: Write TestMapPermissions**

```go
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
		wantPubAllow   []string // subjects that MUST be in Pub.Allow
		wantPubDeny    []string // subjects that MUST NOT be in Pub.Allow
		wantSubAllow   []string // subjects that MUST be in Sub.Allow
		wantResp       bool     // expect Resp to be non-nil
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
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd auth-service && go test -v -race -run TestMapPermissions ./... && go test -v -race -run TestServicePermissions ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add auth-service/permissions_test.go
git commit -m "test: add unit tests for auth-service permission mapping"
```

### Task 2: Service account cache tests

**Files:**
- Create: `auth-service/service_accounts_test.go`
- Reference: `auth-service/service_accounts.go:12-78`

- [ ] **Step 1: Write TestServiceAccountCache_Authenticate**

```go
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
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd auth-service && go test -v -race -run TestServiceAccountCache_Authenticate ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add auth-service/service_accounts_test.go
git commit -m "test: add unit tests for service account cache authentication"
```

---

## Chunk 2: fanout-service tests

### Task 3: LRU cache tests

**Files:**
- Create: `fanout-service/lru_test.go`
- Reference: `fanout-service/main.go:140-254`

- [ ] **Step 1: Write LRU cache tests**

```go
package main

import (
	"fmt"
	"sort"
	"sync"
	"testing"
)

func TestLRUCache_GetSet(t *testing.T) {
	t.Run("get from empty cache returns miss", func(t *testing.T) {
		c := newLRUCache(10)
		_, ok := c.get("room1")
		if ok {
			t.Error("expected miss on empty cache")
		}
	})

	t.Run("set then get returns members", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice", "bob"})
		members, ok := c.get("room1")
		if !ok {
			t.Fatal("expected hit")
		}
		if len(members) != 2 {
			t.Errorf("expected 2 members, got %d", len(members))
		}
	})

	t.Run("set same key updates value", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice"})
		c.set("room1", []string{"alice", "bob", "charlie"})
		members, ok := c.get("room1")
		if !ok {
			t.Fatal("expected hit")
		}
		if len(members) != 3 {
			t.Errorf("expected 3 members, got %d", len(members))
		}
	})

	t.Run("eviction at capacity removes oldest", func(t *testing.T) {
		c := newLRUCache(2)
		c.set("room1", []string{"alice"})
		c.set("room2", []string{"bob"})
		c.set("room3", []string{"charlie"}) // should evict room1
		_, ok := c.get("room1")
		if ok {
			t.Error("room1 should have been evicted")
		}
		_, ok = c.get("room2")
		if !ok {
			t.Error("room2 should still be cached")
		}
		_, ok = c.get("room3")
		if !ok {
			t.Error("room3 should still be cached")
		}
	})

	t.Run("get moves to front preventing eviction", func(t *testing.T) {
		c := newLRUCache(2)
		c.set("room1", []string{"alice"})
		c.set("room2", []string{"bob"})
		c.get("room1")                      // move room1 to front
		c.set("room3", []string{"charlie"}) // should evict room2 (LRU), not room1
		_, ok := c.get("room1")
		if !ok {
			t.Error("room1 should still be cached (was accessed recently)")
		}
		_, ok = c.get("room2")
		if ok {
			t.Error("room2 should have been evicted (LRU)")
		}
	})
}

func TestLRUCache_ApplyDelta(t *testing.T) {
	t.Run("join adds member to existing room", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice"})
		ok := c.applyDelta("room1", "join", "bob")
		if !ok {
			t.Error("expected true for cached room")
		}
		members, _ := c.get("room1")
		sort.Strings(members)
		if len(members) != 2 || members[0] != "alice" || members[1] != "bob" {
			t.Errorf("expected [alice bob], got %v", members)
		}
	})

	t.Run("leave removes member from existing room", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice", "bob"})
		c.applyDelta("room1", "leave", "alice")
		members, _ := c.get("room1")
		if len(members) != 1 || members[0] != "bob" {
			t.Errorf("expected [bob], got %v", members)
		}
	})

	t.Run("leave last member removes room from cache", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice"})
		c.applyDelta("room1", "leave", "alice")
		_, ok := c.get("room1")
		if ok {
			t.Error("room should be removed after last member leaves")
		}
		if c.roomCount() != 0 {
			t.Errorf("expected 0 rooms, got %d", c.roomCount())
		}
	})

	t.Run("join on uncached room returns false", func(t *testing.T) {
		c := newLRUCache(10)
		ok := c.applyDelta("room1", "join", "alice")
		if ok {
			t.Error("expected false for uncached room")
		}
	})

	t.Run("leave on uncached room returns false", func(t *testing.T) {
		c := newLRUCache(10)
		ok := c.applyDelta("room1", "leave", "alice")
		if ok {
			t.Error("expected false for uncached room")
		}
	})
}

func TestLRUCache_IsMember(t *testing.T) {
	c := newLRUCache(10)
	c.set("room1", []string{"alice", "bob"})

	t.Run("existing member", func(t *testing.T) {
		member, cached := c.isMember("room1", "alice")
		if !member || !cached {
			t.Errorf("expected (true, true), got (%v, %v)", member, cached)
		}
	})

	t.Run("non-member in cached room", func(t *testing.T) {
		member, cached := c.isMember("room1", "charlie")
		if member || !cached {
			t.Errorf("expected (false, true), got (%v, %v)", member, cached)
		}
	})

	t.Run("uncached room", func(t *testing.T) {
		member, cached := c.isMember("room2", "alice")
		if member || cached {
			t.Errorf("expected (false, false), got (%v, %v)", member, cached)
		}
	})
}

func TestLRUCache_Metrics(t *testing.T) {
	t.Run("reflects current state", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice", "bob"})
		c.set("room2", []string{"charlie"})

		if c.roomCount() != 2 {
			t.Errorf("expected 2 rooms, got %d", c.roomCount())
		}
		if c.totalMembers() != 3 {
			t.Errorf("expected 3 total members, got %d", c.totalMembers())
		}
	})

	t.Run("counts decrease after eviction", func(t *testing.T) {
		c := newLRUCache(2)
		c.set("room1", []string{"alice"})
		c.set("room2", []string{"bob"})
		c.set("room3", []string{"charlie"}) // evicts room1
		if c.roomCount() != 2 {
			t.Errorf("expected 2 rooms after eviction, got %d", c.roomCount())
		}
		if c.totalMembers() != 2 {
			t.Errorf("expected 2 total members after eviction, got %d", c.totalMembers())
		}
	})
}

func TestLRUCache_Concurrency(t *testing.T) {
	c := newLRUCache(50)
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			room := fmt.Sprintf("room%d", id%5)
			for j := 0; j < 100; j++ {
				c.set(room, []string{fmt.Sprintf("user%d", j)})
				c.get(room)
				c.applyDelta(room, "join", fmt.Sprintf("extra%d", j))
				c.isMember(room, fmt.Sprintf("user%d", j))
				c.roomCount()
				c.totalMembers()
			}
		}(i)
	}
	wg.Wait()
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd fanout-service && go test -v -race -run TestLRUCache ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add fanout-service/lru_test.go
git commit -m "test: add unit tests for fanout-service LRU cache"
```

### Task 4: Singleflight tests

**Files:**
- Create: `fanout-service/singleflight_test.go`
- Reference: `fanout-service/main.go:257-293`

- [ ] **Step 1: Write singleflight tests**

```go
package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestSingleflight_Dedup(t *testing.T) {
	sf := newSingleflight()
	var callCount atomic.Int32
	expected := []string{"alice", "bob"}

	var wg sync.WaitGroup
	results := make([][]string, 10)

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			results[idx] = sf.do("room1", func() []string {
				callCount.Add(1)
				return expected
			})
		}(i)
	}
	wg.Wait()

	if count := callCount.Load(); count != 1 {
		t.Errorf("expected fn to be called once, got %d", count)
	}
	for i, r := range results {
		if len(r) != 2 || r[0] != "alice" || r[1] != "bob" {
			t.Errorf("goroutine %d got unexpected result: %v", i, r)
		}
	}
}

func TestSingleflight_IndependentKeys(t *testing.T) {
	sf := newSingleflight()
	var count1, count2 atomic.Int32

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		sf.do("key1", func() []string {
			count1.Add(1)
			return []string{"a"}
		})
	}()

	go func() {
		defer wg.Done()
		sf.do("key2", func() []string {
			count2.Add(1)
			return []string{"b"}
		})
	}()

	wg.Wait()

	if count1.Load() != 1 {
		t.Errorf("key1 fn should be called once, got %d", count1.Load())
	}
	if count2.Load() != 1 {
		t.Errorf("key2 fn should be called once, got %d", count2.Load())
	}
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd fanout-service && go test -v -race -run TestSingleflight ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add fanout-service/singleflight_test.go
git commit -m "test: add unit tests for fanout-service singleflight dedup"
```

---

## Chunk 3: room-service tests

### Task 5: Local membership tests

**Files:**
- Create: `room-service/membership_test.go`
- Reference: `room-service/main.go:82-146`

- [ ] **Step 1: Write local membership tests**

```go
package main

import (
	"fmt"
	"sort"
	"sync"
	"testing"
)

func TestLocalMembership_AddRemove(t *testing.T) {
	t.Run("add user to room", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		members := m.members("room1")
		if len(members) != 1 || members[0] != "alice" {
			t.Errorf("expected [alice], got %v", members)
		}
	})

	t.Run("add duplicate is idempotent", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.add("room1", "alice")
		members := m.members("room1")
		if len(members) != 1 {
			t.Errorf("expected 1 member after duplicate add, got %d", len(members))
		}
	})

	t.Run("remove user from room", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.add("room1", "bob")
		m.remove("room1", "alice")
		members := m.members("room1")
		if len(members) != 1 || members[0] != "bob" {
			t.Errorf("expected [bob], got %v", members)
		}
	})

	t.Run("remove non-existent user is no-op", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.remove("room1", "bob") // should not panic
		members := m.members("room1")
		if len(members) != 1 {
			t.Errorf("expected 1 member, got %d", len(members))
		}
	})

	t.Run("remove last user deletes room", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.remove("room1", "alice")
		members := m.members("room1")
		if members != nil {
			t.Errorf("expected nil for empty room, got %v", members)
		}
		if m.roomCount() != 0 {
			t.Errorf("expected 0 rooms, got %d", m.roomCount())
		}
	})
}

func TestLocalMembership_Members(t *testing.T) {
	t.Run("non-existent room returns nil", func(t *testing.T) {
		m := newLocalMembership()
		if m.members("room1") != nil {
			t.Error("expected nil for non-existent room")
		}
	})

	t.Run("multiple users returned", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.add("room1", "bob")
		m.add("room1", "charlie")
		members := m.members("room1")
		sort.Strings(members)
		if len(members) != 3 || members[0] != "alice" || members[1] != "bob" || members[2] != "charlie" {
			t.Errorf("expected [alice bob charlie], got %v", members)
		}
	})

	t.Run("members is a snapshot", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		members := m.members("room1")
		members[0] = "hacked"
		actual := m.members("room1")
		if actual[0] != "alice" {
			t.Error("modifying returned slice should not affect internal state")
		}
	})
}

func TestLocalMembership_Reset(t *testing.T) {
	m := newLocalMembership()
	m.add("room1", "alice")
	m.add("room2", "bob")
	m.reset()

	if m.roomCount() != 0 {
		t.Errorf("expected 0 rooms after reset, got %d", m.roomCount())
	}
	if m.members("room1") != nil {
		t.Error("expected nil after reset")
	}
}

func TestLocalMembership_SwapFrom(t *testing.T) {
	t.Run("target gets source data", func(t *testing.T) {
		source := newLocalMembership()
		source.add("room1", "alice")
		source.add("room2", "bob")

		target := newLocalMembership()
		target.add("room3", "charlie")
		target.swapFrom(source)

		if target.roomCount() != 2 {
			t.Errorf("expected target to have 2 rooms, got %d", target.roomCount())
		}
		members := target.members("room1")
		if len(members) != 1 || members[0] != "alice" {
			t.Errorf("expected target room1 = [alice], got %v", members)
		}
		if target.members("room3") != nil {
			t.Error("target should not have old room3 data")
		}
	})

	t.Run("source retains data after swap", func(t *testing.T) {
		source := newLocalMembership()
		source.add("room1", "alice")

		target := newLocalMembership()
		target.swapFrom(source)

		// Source and target now share the same map reference
		if source.roomCount() != 1 {
			t.Errorf("source should retain data, got roomCount=%d", source.roomCount())
		}
	})
}

func TestLocalMembership_Concurrency(t *testing.T) {
	m := newLocalMembership()
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			room := fmt.Sprintf("room%d", id%3)
			user := fmt.Sprintf("user%d", id)
			for j := 0; j < 100; j++ {
				m.add(room, user)
				m.members(room)
				m.roomCount()
				m.remove(room, user)
			}
		}(i)
	}
	wg.Wait()
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd room-service && go test -v -race -run TestLocalMembership ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add room-service/membership_test.go
git commit -m "test: add unit tests for room-service local membership"
```

---

## Chunk 4: persist-worker tests

### Task 6: E2EE decryption and key cache tests

**Files:**
- Create: `persist-worker/e2ee_test.go`
- Reference: `persist-worker/main.go:80-138,170-213`

- [ ] **Step 1: Write E2EE tests**

```go
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

// encryptTestPayload creates a valid AES-256-GCM ciphertext for testing.
// Returns base64(nonce || ciphertext || tag).
func encryptTestPayload(t *testing.T, plaintext string, key []byte, room, user string, timestamp int64, epoch int) string {
	t.Helper()

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("NewCipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("NewGCM: %v", err)
	}

	nonce := make([]byte, gcm.NonceSize()) // 12 bytes
	if _, err := rand.Read(nonce); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}

	type aadPayload struct {
		Room      string `json:"room"`
		User      string `json:"user"`
		Timestamp int64  `json:"timestamp"`
		Epoch     int    `json:"epoch"`
	}
	aad, err := json.Marshal(aadPayload{Room: room, User: user, Timestamp: timestamp, Epoch: epoch})
	if err != nil {
		t.Fatalf("marshal AAD: %v", err)
	}

	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), aad)
	// nonce || ciphertext+tag
	result := make([]byte, len(nonce)+len(ciphertext))
	copy(result, nonce)
	copy(result[len(nonce):], ciphertext)

	return base64.StdEncoding.EncodeToString(result)
}

func TestDecryptE2EEText(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}

	room := "test-room"
	user := "alice"
	var timestamp int64 = 1234567890
	epoch := 1

	t.Run("valid ciphertext decrypts correctly", func(t *testing.T) {
		ct := encryptTestPayload(t, "Hello, world!", key, room, user, timestamp, epoch)
		got, err := decryptE2EEText(ct, key, room, user, timestamp, epoch)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "Hello, world!" {
			t.Errorf("expected 'Hello, world!', got %q", got)
		}
	})

	t.Run("wrong key fails", func(t *testing.T) {
		ct := encryptTestPayload(t, "secret", key, room, user, timestamp, epoch)
		wrongKey := make([]byte, 32)
		if _, err := rand.Read(wrongKey); err != nil {
			t.Fatalf("rand.Read: %v", err)
		}
		_, err := decryptE2EEText(ct, wrongKey, room, user, timestamp, epoch)
		if err == nil {
			t.Error("expected error with wrong key")
		}
	})

	t.Run("short ciphertext fails", func(t *testing.T) {
		short := base64.StdEncoding.EncodeToString([]byte("too short"))
		_, err := decryptE2EEText(short, key, room, user, timestamp, epoch)
		if err == nil {
			t.Error("expected error for short ciphertext")
		}
	})

	t.Run("bad base64 fails", func(t *testing.T) {
		_, err := decryptE2EEText("not-valid-base64!!!", key, room, user, timestamp, epoch)
		if err == nil {
			t.Error("expected error for bad base64")
		}
	})

	t.Run("wrong AAD room fails", func(t *testing.T) {
		ct := encryptTestPayload(t, "secret", key, room, user, timestamp, epoch)
		_, err := decryptE2EEText(ct, key, "other-room", user, timestamp, epoch)
		if err == nil {
			t.Error("expected error with wrong AAD room")
		}
	})

	t.Run("empty plaintext succeeds", func(t *testing.T) {
		ct := encryptTestPayload(t, "", key, room, user, timestamp, epoch)
		got, err := decryptE2EEText(ct, key, room, user, timestamp, epoch)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "" {
			t.Errorf("expected empty string, got %q", got)
		}
	})
}

func TestRoomKeyCache_GetPut(t *testing.T) {
	t.Run("put then get returns hit", func(t *testing.T) {
		c := &roomKeyCache{
			keys:    make(map[string][]byte),
			maxKeys: 10,
		}
		c.put("room1", 1, []byte("key-data"))
		got, ok := c.get("room1", 1)
		if !ok {
			t.Fatal("expected cache hit")
		}
		if string(got) != "key-data" {
			t.Errorf("expected 'key-data', got %q", string(got))
		}
	})

	t.Run("get missing returns miss", func(t *testing.T) {
		c := &roomKeyCache{
			keys:    make(map[string][]byte),
			maxKeys: 10,
		}
		_, ok := c.get("room1", 1)
		if ok {
			t.Error("expected cache miss")
		}
	})

	t.Run("eviction at capacity", func(t *testing.T) {
		c := &roomKeyCache{
			keys:    make(map[string][]byte),
			maxKeys: 2,
		}
		c.put("room1", 1, []byte("key1"))
		c.put("room2", 1, []byte("key2"))
		c.put("room3", 1, []byte("key3")) // should evict room1

		_, ok := c.get("room1", 1)
		if ok {
			t.Error("room1 should have been evicted")
		}
		_, ok = c.get("room2", 1)
		if !ok {
			t.Error("room2 should still be cached")
		}
		_, ok = c.get("room3", 1)
		if !ok {
			t.Error("room3 should still be cached")
		}
	})

	t.Run("put same key updates value", func(t *testing.T) {
		c := &roomKeyCache{
			keys:    make(map[string][]byte),
			maxKeys: 10,
		}
		c.put("room1", 1, []byte("old"))
		c.put("room1", 1, []byte("new"))
		got, ok := c.get("room1", 1)
		if !ok {
			t.Fatal("expected hit")
		}
		if string(got) != "new" {
			t.Errorf("expected 'new', got %q", string(got))
		}
	})
}

func TestRoomKeyCache_Invalidate(t *testing.T) {
	t.Run("invalidate existing entry", func(t *testing.T) {
		c := &roomKeyCache{
			keys:    make(map[string][]byte),
			maxKeys: 10,
		}
		c.put("room1", 1, []byte("key"))
		c.invalidate("room1", 1)
		_, ok := c.get("room1", 1)
		if ok {
			t.Error("expected miss after invalidation")
		}
	})

	t.Run("invalidate non-existent is no-op", func(t *testing.T) {
		c := &roomKeyCache{
			keys:    make(map[string][]byte),
			maxKeys: 10,
		}
		c.invalidate("room1", 1) // should not panic
	})
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd persist-worker && go test -v -race -run "TestDecryptE2EEText|TestRoomKeyCache" ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add persist-worker/e2ee_test.go
git commit -m "test: add unit tests for persist-worker E2EE decryption and key cache"
```

### Task 7: Nullable helper tests

**Files:**
- Create: `persist-worker/helpers_test.go`
- Reference: `persist-worker/main.go:32-35,59-78`

- [ ] **Step 1: Write nullable helper tests**

```go
package main

import "testing"

func TestNullableString(t *testing.T) {
	if nullableString("") != nil {
		t.Error("expected nil for empty string")
	}
	if nullableString("hello") != "hello" {
		t.Error("expected 'hello' for non-empty string")
	}
}

func TestNullableInt64(t *testing.T) {
	if nullableInt64(0) != nil {
		t.Error("expected nil for zero")
	}
	got := nullableInt64(42)
	if got != int64(42) {
		t.Errorf("expected 42, got %v", got)
	}
}

func TestNullableE2EEEpoch(t *testing.T) {
	if nullableE2EEEpoch(nil) != nil {
		t.Error("expected nil for nil E2EEInfo")
	}
	got := nullableE2EEEpoch(&E2EEInfo{Epoch: 3})
	if got != 3 {
		t.Errorf("expected 3, got %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd persist-worker && go test -v -race -run "TestNullable" ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/julianshen/prj/nats-chat-keycloak
git add persist-worker/helpers_test.go
git commit -m "test: add unit tests for persist-worker nullable helpers"
```

---

## Chunk 5: Final verification

### Task 8: Run all tests across all 4 services

- [ ] **Step 1: Run full test suite**

Run:
```bash
cd /Users/julianshen/prj/nats-chat-keycloak
for svc in auth-service fanout-service room-service persist-worker; do
  echo "=== $svc ===" && (cd $svc && go test -v -race ./...)
done
```

Expected: All tests PASS with `-race` flag. No data races detected.

- [ ] **Step 2: Verify test count**

Expected test functions:
- auth-service: TestMapPermissions (6 subtests), TestServicePermissions, TestServiceAccountCache_Authenticate (6 subtests)
- fanout-service: TestLRUCache_GetSet (5), TestLRUCache_ApplyDelta (4), TestLRUCache_IsMember (3), TestLRUCache_Metrics, TestLRUCache_Concurrency, TestSingleflight_Dedup, TestSingleflight_IndependentKeys
- room-service: TestLocalMembership_AddRemove (5), TestLocalMembership_Members (2), TestLocalMembership_Reset, TestLocalMembership_SwapFrom (2), TestLocalMembership_Concurrency
- persist-worker: TestDecryptE2EEText (6), TestRoomKeyCache_GetPut (4), TestRoomKeyCache_Invalidate (2), TestNullableString, TestNullableInt64, TestNullableE2EEEpoch

- [ ] **Step 3: Final commit with all test files**

If any tests were adjusted during verification, commit fixes:
```bash
git add -A
git commit -m "test: finalize test suite for high-value Go services"
```
