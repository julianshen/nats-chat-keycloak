package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

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

	nonce := make([]byte, gcm.NonceSize())
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
			order:   make([]string, 0),
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
			order:   make([]string, 0),
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
			order:   make([]string, 0),
			maxKeys: 2,
		}
		c.put("room1", 1, []byte("key1"))
		c.put("room2", 1, []byte("key2"))
		c.put("room3", 1, []byte("key3"))

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
			order:   make([]string, 0),
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
			order:   make([]string, 0),
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
			order:   make([]string, 0),
			maxKeys: 10,
		}
		c.invalidate("room1", 1)
	})
}
