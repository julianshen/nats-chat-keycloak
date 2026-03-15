# Test Suite Design: High-Value Go Services

**Date:** 2026-03-15
**Status:** Approved
**Scope:** Unit tests for pure business logic in auth-service, fanout-service, room-service, persist-worker

---

## Goal

Add unit tests to the 4 highest-risk Go services, targeting pure business logic functions that require no NATS or PostgreSQL connections. Tests use Go's standard `testing` package with table-driven subtests and `-race` flag.

## Out of Scope

- NATS message handler tests (require live connection)
- Database query tests (require PostgreSQL)
- Keycloak JWT validation (requires JWKS endpoint)
- Frontend tests (separate effort)
- Integration/E2E tests (separate effort)

---

## Test Files

### 1. auth-service/permissions_test.go

**Target:** `mapPermissions(roles []string, username string) jwt.Permissions` (permissions.go:36-182) and `servicePermissions()` (permissions.go:184-195)

**Test function:** `TestMapPermissions` — table-driven with subtests

| Subtest | Input Roles | Key Assertions |
|---------|-------------|----------------|
| admin+user roles | `["admin", "user"]` | Has `deliver.{username}.send.>` publish, `admin.>` publish, `deliver.{username}.>` subscribe |
| user role only | `["user"]` | Has `deliver.{username}.send.>` publish, `deliver.{username}.>` subscribe, no `admin.>` |
| no roles (restricted) | `[]` | Has limited publish (chat.history, msg.get, room.join, presence.update), no sendSubject, no admin.>, no room.create |
| admin without user | `["admin"]` | Admin subjects present, user-level subjects present (admin implies user) |
| username in subjects | `["user"]` with username "alice" | `deliver.alice.>` appears in subscribe permissions |
| unknown roles ignored | `["user", "unknown"]` | Same as user-only, unknown role has no effect |

**Test function:** `TestServicePermissions` — verify static service account permissions include wildcard publish/subscribe and 5-minute response timeout.

### 2. auth-service/service_accounts_test.go

**Target:** `ServiceAccountCache.Authenticate(username, password string) bool` (service_accounts.go:73-78)

**Approach:** Construct a `ServiceAccountCache` struct literal with a pre-populated `accounts` map[string]string (bypassing `NewServiceAccountCache` which requires a DB and spawns a goroutine). Test the pure comparison logic.

```go
cache := &ServiceAccountCache{
    accounts: map[string]string{"svc-user": "svc-pass"},
}
```

**Test function:** `TestServiceAccountCache_Authenticate` — table-driven

| Subtest | Input | Expected |
|---------|-------|----------|
| correct credentials | known user + correct pass | true |
| wrong password | known user + wrong pass | false |
| missing user | unknown user | false |
| empty password | known user + "" | false |
| case sensitivity | known user + wrong-case pass | false |

### 3. fanout-service/lru_test.go

**Target:** `lruCache` struct (main.go:140-254)

**Test functions:**

`TestLRUCache_GetSet` (~6 subtests)
- Get from empty cache → miss
- Set then get → hit with correct members
- Set same key twice → updated value
- Get moves entry to front (MRU)
- Set beyond capacity → oldest evicted
- Eviction preserves newer entries

`TestLRUCache_ApplyDelta` (~5 subtests)
- Join to existing room → member added
- Leave from existing room → member removed
- Leave last member → room entry removed from cache
- Join to non-cached room → returns false (cache miss)
- Leave from non-cached room → returns false (cache miss)

`TestLRUCache_IsMember` (~3 subtests)
- Member exists → `(true, true)`
- Room cached but user not member → `(false, true)`
- Room not cached → `(false, false)`

`TestLRUCache_Metrics` (~2 subtests)
- roomCount and totalMembers reflect current state
- After eviction, counts decrease

`TestLRUCache_Concurrency`
- 10 goroutines × 100 iterations of get/set/applyDelta
- Run with `-race` → no data races

### 4. fanout-service/singleflight_test.go

**Target:** `singleflight` struct (main.go:257-293)

**Test functions:**

`TestSingleflight_Dedup`
- Launch 10 goroutines calling `do("same-key", fn)` concurrently
- `fn` increments an atomic counter
- Assert counter == 1 (only one execution)
- Assert all goroutines received the same result

`TestSingleflight_IndependentKeys`
- Launch goroutines with different keys
- Assert each key's fn executes independently

### 5. room-service/membership_test.go

**Target:** `localMembership` struct (main.go:81-146)

**Test functions:**

`TestLocalMembership_AddRemove` (~5 subtests)
- Add user to room → members() includes user
- Add duplicate → idempotent (no double entry)
- Remove user → members() excludes user
- Remove non-existent → no-op (no panic)
- Remove last user → room disappears from map

`TestLocalMembership_Members` (~3 subtests)
- Non-existent room → nil/empty
- Multiple users → all returned
- Members are a snapshot (modifying result doesn't affect internal state)

`TestLocalMembership_Reset` (~2 subtests)
- Populated membership → reset → roomCount == 0
- Members after reset → empty

`TestLocalMembership_SwapFrom` (~3 subtests)
- Build source with data, build target with different data
- SwapFrom → target has source's data
- Source retains its data (both share the same map reference after swap)

`TestLocalMembership_Concurrency`
- 10 goroutines doing add/remove/members concurrently
- Run with `-race` → no data races

### 6. persist-worker/e2ee_test.go

**Target:** `decryptE2EEText()` (main.go:170-213) and `roomKeyCache` (main.go:80-138)

**Test functions for decryption:**

`TestDecryptE2EEText` (~6 subtests)

Test setup: Generate AES-256-GCM ciphertext in-test using Go's `crypto/aes` + `crypto/cipher`:
1. Create 32-byte key
2. Build AAD JSON: `{"room":"test-room","user":"alice","timestamp":1234567890,"epoch":1}`
3. Generate 12-byte nonce
4. Encrypt known plaintext with AES-GCM + AAD
5. Encode as `base64(nonce || ciphertext || tag)`

| Subtest | Input | Expected |
|---------|-------|----------|
| valid ciphertext | correct key + matching AAD | original plaintext |
| wrong key | different 32-byte key | error (auth tag mismatch) |
| short ciphertext | base64 of < 28 bytes | error "ciphertext too short" |
| bad base64 | "not-valid-base64!!!" | error from base64 decode |
| wrong AAD (different room) | correct key, room="other" | error (auth tag mismatch) |
| empty plaintext | valid encrypt of "" | "" (no error) |

**Test functions for key cache:**

`TestRoomKeyCache_GetPut` (~4 subtests)

Note: Tests use struct literal with small `maxKeys` (e.g., 3) to test eviction without inserting 1000 entries.

- Put then get → hit
- Get missing → miss
- Put at capacity → oldest evicted (FIFO)
- Put same key twice → updated value

`TestRoomKeyCache_Invalidate` (~2 subtests)
- Invalidate existing → get returns miss
- Invalidate non-existent → no-op (no panic)

### 7. persist-worker/helpers_test.go

**Target:** `nullableString()`, `nullableInt64()`, `nullableE2EEEpoch()` (main.go:59-78)

**Test functions:**

`TestNullableString` — `""` → nil, `"hello"` → `"hello"`
`TestNullableInt64` — `0` → nil, `42` → `int64(42)`
`TestNullableE2EEEpoch` — `nil` → nil, `&E2EEInfo{Epoch:3}` → `3`

---

## Running Tests

```bash
# Individual service
cd auth-service && go test -v -race ./...
cd fanout-service && go test -v -race ./...
cd room-service && go test -v -race ./...
cd persist-worker && go test -v -race ./...

# All services (from project root)
for svc in auth-service fanout-service room-service persist-worker; do
  echo "=== $svc ===" && (cd $svc && go test -v -race ./...)
done
```

All tests must pass with `-race` flag to catch concurrent access bugs in cache/membership structures.

## Constraints

- No external test dependencies — standard library only
- No mocking frameworks — use struct initialization and interface satisfaction
- Test files use `package main` for white-box access to unexported symbols
- No I/O in any test — no network, no filesystem, no database
- Each test file is self-contained and independently runnable

## Estimated Coverage

| Service | Testable LOC | Covered Functions | Coverage Type |
|---------|-------------|-------------------|---------------|
| auth-service | ~180 | mapPermissions, servicePermissions, Authenticate | Permission logic, auth cache |
| fanout-service | ~150 | LRU cache (5 methods), singleflight.do | Cache correctness, dedup |
| room-service | ~70 | localMembership (6 methods) | Membership state machine |
| persist-worker | ~120 | decryptE2EEText, roomKeyCache (3 methods), 3 helpers | Crypto, cache, type helpers |
| **Total** | **~520** | **24 test functions, ~78 subtests** | Pure business logic |
