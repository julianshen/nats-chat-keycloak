# Architecture & Implementation Review Report

**Project:** nats-chat-keycloak
**Date:** 2026-03-14
**Scope:** Full codebase review — backend services, frontend, security, infrastructure

---

## Codebase Analytics

| Metric | Value |
|--------|-------|
| **Go source** | 8,541 lines across 21 files (13 services + shared pkg) |
| **TypeScript/TSX** | 8,786 lines across 45 files (React + Angular + Poll) |
| **Java** | 694 lines across 6 files (KB service) |
| **Infrastructure** | 461 lines docker-compose + 2,377 lines K8s YAML |
| **Dockerfiles** | 20 |
| **Total services** | 13 backend + 3 frontends + 8 infrastructure |

---

## 1. Architecture Assessment

### 1.1 Overall Design: Grade A-

The system demonstrates strong distributed systems thinking:

- **NATS as the sole communication backbone** — no HTTP between services, clean event-driven architecture
- **Auth callout pattern** — centralizes authentication without per-service token validation
- **Sharded KV membership** — `{room}.{userId}` keys enable O(1) join/leave with zero read-modify-write conflicts
- **Delta events** — `room.changed.{room}` emits ~50-byte deltas instead of full state, reducing bandwidth
- **Hybrid delivery** — room multicast for main messages + per-user subjects for threads/DMs
- **Full OTel instrumentation** — browser-to-backend W3C trace propagation across all services

### 1.2 Key Design Strengths

| Pattern | Implementation | Rating |
|---------|---------------|--------|
| Auth callout with leader election | auth-service/leader.go | Excellent |
| Sharded KV membership | room-service (ROOMS bucket) | Excellent |
| Dual-index presence | presence-service (forward + reverse) | Excellent |
| LRU cache + singleflight | fanout-service | Excellent |
| AppBridge SDK isolation | web/src/lib/AppBridge.ts | Good |
| E2EE with epoch rotation | e2ee-key-service + E2EEManager.ts | Good |
| Shared OTel package | pkg/otelhelper/ | Excellent |
| Connection guard pattern | NatsProvider.tsx (ncRef check) | Excellent |

### 1.3 Architectural Concerns

| Concern | Impact | Details |
|---------|--------|---------|
| MessageProvider.tsx (1,015 lines) | Maintainability | Single provider handling subscriptions, messages, translations, DMs, unread counts, app events — should be decomposed into focused hooks |
| 13 services duplicating boilerplate | Maintainability | envOrDefault(), NATS retry, DB retry, shutdown handler all copy-pasted (~300 lines total duplication) |
| No standardized error response schema | Consistency | fanout returns `{"error":"..."}`, history returns `{"messages":[],"hasMore":false}`, sticker returns `[]` |
| In-memory state without reconnect handlers | Reliability | 8 of 13 Go services lack ReconnectHandler — membership caches become stale after NATS reconnection |
| KB concurrent editing has no conflict resolution | Data integrity | Last-write-wins; two editors overwrite each other |

---

## 2. Security Assessment

### 2.1 Severity Summary

| Severity | Count | Key Items |
|----------|-------|-----------|
| **CRITICAL** | 3 | Hardcoded NKey/XKey seeds, plaintext service passwords in DB, WebSocket no TLS |
| **HIGH** | 5 | Keycloak brute force disabled, K8s secrets in git, no resource limits, no security context, redirect URI wildcard |
| **MEDIUM** | 5 | 24h service JWT expiry, no RLS, unencrypted OTel, tokens in logs, open monitoring ports |
| **LOW** | 3 | No auth rate limiting, loose input validation, no CSP headers |

### 2.2 Critical Findings

**1. Hardcoded NKey/XKey Seeds**
- Location: `docker-compose.yml:60-61`, `nats-server.conf`, `k8s/overlays/local/secrets.yaml`
- Impact: If leaked, entire NATS auth system compromised — attacker can mint arbitrary user JWTs
- Fix: External secrets manager (Vault, AWS Secrets Manager, sealed-secrets)

**2. Plaintext Service Account Passwords**
- Location: `postgres/init.sql:200-214`, `auth-service/service_accounts.go`
- Impact: Database compromise = all service credentials exposed
- Fix: Hash with bcrypt/argon2; compare hashes at auth time

**3. WebSocket Without TLS**
- Location: `nats-server.conf:35` (`no_tls: true`)
- Impact: JWTs and all chat messages transmitted in cleartext; MITM interception trivial
- Fix: Enable TLS on WebSocket listener; provide certificates

**4. XSS in KB Page Editor**
- Location: `apps/kb/app/src/page-editor.component.ts:198`
- Issue: Unsanitized content assigned directly to DOM element — stored XSS risk
- Fix: Sanitize with Angular's `DomSanitizer` or DOMPurify before rendering

### 2.3 Keycloak Hardening Needed

```
sslRequired: "none"           → "external"
bruteForceProtected: false    → true (max 30 failures)
redirectUris: ["../*"]        → exact paths only
```

### 2.4 K8s Security Gaps

- No `securityContext` (containers run as root)
- No `NetworkPolicy` (all pods can talk to all pods)
- No resource limits (CPU/memory unbounded)
- Secrets stored unencrypted in git

### 2.5 What's Done Well

- Parameterized SQL everywhere (no SQL injection)
- PKCE enabled for browser OIDC flow
- Tokens stored in-memory only (not localStorage)
- E2EE uses proper crypto (P-256 ECDH + AES-256-GCM)
- Non-extractable private keys in browser
- Membership checks before E2EE key distribution
- Monotonic epoch enforcement prevents rollback attacks

---

## 3. Backend Services Analysis

### 3.1 Code Quality by Service

| Service | Lines | Complexity | Quality | Notable Issues |
|---------|-------|------------|---------|----------------|
| auth-service | Multi-file | High | A | Raw sql.Open (not otelsql) for service accounts |
| fanout-service | 1,060 | High | A | Circuit breaker RecordSuccess called on KV failure |
| room-service | 1,066 | High | A | Solid; no issues found |
| presence-service | 817 | High | A- | KV watcher goroutine lacks ctx.Done() select |
| persist-worker | 685 | Medium | B+ | No TracedPublish; E2EE fallback stores ciphertext |
| history-service | 469 | Medium | B | Hardcoded 200-thread limit; inconsistent error responses |
| e2ee-key-service | 500+ | High | B+ | KV key sanitization creates collision risk |
| read-receipt-service | 400+ | Medium | B+ | Good eventual consistency pattern |
| user-search-service | 267 | Low | B | No queue group; single-instance only |
| translation-service | 279 | Low | B | Health check via atomic bool works |
| sticker-service | 231 | Low | B | No queue group |
| app-registry-service | 300 | Low | B+ | Clean CRUD |
| poll-service | ~300 | Low | B+ | Clean room app pattern |
| KB service (Java) | 694 | Medium | B | XSS risk; no conflict resolution; no pagination |

### 3.2 Shared Package (pkg/otelhelper): Grade A

- Correct slog deadlock avoidance (uses `slog.NewJSONHandler`, not default handler)
- W3C trace context propagation across NATS
- Consistent span creation (PRODUCER, CONSUMER, SERVER, CLIENT)
- Pre-configured histogram buckets for NATS latencies
- Minor: exporter creation errors silently ignored

### 3.3 Cross-Service Consistency

| Aspect | Consistent? | Details |
|--------|-------------|---------|
| NATS connection retry (30x, 2s) | Yes | All 13 services |
| OTel initialization | Yes | All use otelhelper.Init() |
| Queue group usage | **No** | sticker-service, user-search-service missing |
| ReconnectHandler | **No** | Only 5 of 13 services |
| Shutdown (Drain vs Close) | **No** | 8 drain, 5 close — semantically different |
| Error response format | **No** | No standard schema |
| Metric error handling | Consistent (bad) | All suppress errors with `_` |

### 3.4 Duplication Hotspots

| Pattern | Occurrences | Lines Saved if Extracted |
|---------|-------------|------------------------|
| `envOrDefault()` | 13 | ~65 |
| NATS connection + retry loop | 13 | ~130 |
| PostgreSQL connection + retry | 8 | ~80 |
| Signal handler + shutdown | 13 | ~50 |
| **Total** | | **~325 lines** |

---

## 4. Frontend Analysis

### 4.1 React App (web/): Grade B+

**Strengths:**
- Clean provider chain: Auth → NATS → E2EE → Message
- Connection guard prevents old connection callbacks from corrupting state
- Minimal dependencies (no UI framework, custom markdown parser)
- Proper subscription cleanup in useEffect returns
- `beforeunload` handler flushes leave events

**Issues:**

| Issue | Severity | Location |
|-------|----------|----------|
| MessageProvider.tsx is 1,015 lines | High | Should split into useMessages, useSubscriptions, useTranslation, useUnread hooks |
| No React Error Boundaries | High | Provider crash = white screen |
| Token refresh interval never cleared | Medium | AuthProvider.tsx:74 — leaks on logout |
| No user-facing error recovery UI | Medium | Errors only logged to console |
| Async iterator edge case on unmount | Low | for-await loops may continue briefly after unsubscribe |
| No ARIA labels or keyboard navigation | Medium | Accessibility gaps |
| AppBridge callback registry never pruned | Low | Leaked callbacks if app crashes before destroyAppBridge() |

### 4.2 KB Angular App: Grade B-

- Zoneless change detection is cutting-edge but requires careful `markForCheck()` discipline
- Unsanitized content rendered to DOM (XSS risk — CRITICAL)
- `document.execCommand()` is deprecated for rich text
- No conflict resolution for concurrent edits
- Missing `bridge.subscribe` cleanup in `ngOnDestroy`
- No pagination for page list

### 4.3 Poll App (React): Grade B+

- Clean AppBridge consumer pattern
- Proper request-reply + event subscription
- Simple and focused

---

## 5. Infrastructure Analysis

### 5.1 Docker Compose: Grade B

**Good:** Health checks, depends_on ordering, named volumes, service restart policies
**Missing:** Resource limits, network segmentation, secrets management, web service restart policy

### 5.2 Kubernetes: Grade C+

**Good:** StatefulSets for stateful services, ConfigMaps/Secrets separation, Kustomize overlays
**Missing:** Resource limits, securityContext, NetworkPolicies, TLS, backup strategy, image digests

### 5.3 Observability: Grade A-

**Excellent coverage:**
- All 13 Go services + 1 Java service fully instrumented
- Browser traces propagated to backend via W3C traceparent
- Metrics: per-service counters + latency histograms
- Logs: structured slog with trace_id/span_id injection
- Grafana dashboards with Tempo (traces) + Prometheus (metrics) + Loki (logs)

**Gap:** No alerting rules configured

---

## 6. Prioritized Recommendations

### Immediate (Security)

1. **Enable WebSocket TLS** — tokens and messages are in cleartext
2. **Hash service account passwords** — bcrypt/argon2 in PostgreSQL
3. **Fix KB page editor XSS** — sanitize content with DomSanitizer/DOMPurify before DOM assignment
4. **Enable Keycloak brute force protection** — currently disabled
5. **Remove secrets from git** — use sealed-secrets or external secrets operator

### Short-Term (Reliability)

6. **Add ReconnectHandlers** to all services with in-memory state (8 services)
7. **Add React Error Boundaries** — at minimum around NatsProvider and MessageProvider
8. **Fix AuthProvider token refresh leak** — store and clear interval on unmount
9. **Standardize error response format** — `{"error": "code", "message": "text"}` across all services
10. **Add K8s resource limits** — prevent resource starvation

### Medium-Term (Maintainability)

11. **Extract shared Go boilerplate** — `pkg/config`, `pkg/natsutil`, `pkg/dbutil` (~325 lines saved)
12. **Split MessageProvider.tsx** — decompose into focused hooks (useSubscriptions, useMessages, useTranslation, useUnread)
13. **Add K8s security contexts** — runAsNonRoot, readOnlyRootFilesystem, drop ALL capabilities
14. **Add NetworkPolicies** — segment web/services/data tiers
15. **Add pagination to KB page list** — currently loads all pages

### Long-Term (Quality)

16. **Add test suites** — no tests exist in any service
17. **Add conflict resolution for KB editor** — OT or CRDT for concurrent editing
18. **Implement alerting** — Prometheus alerting rules + alert manager
19. **Add accessibility** — ARIA labels, keyboard navigation, focus management
20. **Consider service mesh** — mTLS between services as the system grows

---

## 7. Architecture Diagram (Current State)

```
                    Browser (React + nats.ws)
                         |
                    OIDC login
                         |
                    +----------+
                    | Keycloak | (:8080)
                    |   OIDC   |
                    +----+-----+
                         | access_token
                         v
              +---------------------+
              |   NATS Server 2.12  | (:4222/9222/8222)
              |  auth_callout + JS  |
              +--+--+--+--+--+--+--+
                 |  |  |  |  |  |
    +------------+  |  |  |  |  +------------+
    v               v  v  v  v               v
 auth-svc      fanout room presence      e2ee-key
 (leader)      (pool) (KV) (dual-KV)    (epoch)
                 |
    +------------+------------+
    v            v            v
 persist     history      user-search
 (JS->PG)    (PG->reply)  (KC admin)
    |
    v
 +----------+     +---------------+
 |PostgreSQL|     |  OTel Stack   |
 |  (:5432) |     | Tempo+Prom+   |
 +----------+     | Loki+Grafana  |
                  +---------------+
```

---

## 8. Scorecard

| Category | Grade | Key Factor |
|----------|-------|------------|
| **Architecture** | A- | Excellent NATS-centric design; minor consistency gaps |
| **Security** | C+ | Strong auth design, but demo-mode secrets and no TLS |
| **Backend Code** | B+ | Consistent patterns, good OTel; boilerplate duplication |
| **Frontend Code** | B | Clean provider model; oversized MessageProvider, no error boundaries |
| **Infrastructure** | B- | Functional but missing production hardening |
| **Observability** | A- | Full trace/metric/log pipeline; no alerting |
| **Testing** | F | No test suites in any service |
| **Accessibility** | D | No ARIA, no keyboard nav |
| **Overall** | **B** | Strong architecture, needs production hardening |

---

*Generated by comprehensive codebase analysis on 2026-03-14*
