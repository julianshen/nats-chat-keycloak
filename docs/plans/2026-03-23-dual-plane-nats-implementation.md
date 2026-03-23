# Dual-Plane NATS (Core + JetStream) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a production-safe dual-plane model where ephemeral traffic stays on Core NATS and durable chat events flow through JetStream, with zero-downtime migration.

**Architecture:** Keep a single NATS deployment and split behavior by subject namespace. Ingest remains `deliver.{user}.send.>` (Core), fanout publishes durable events to `chat.msg.*` (JetStream-captured), notify remains `room.notify.*` + `msg.get` (Core), history remains DB-backed request/reply.

**Tech Stack:** Go services (fanout, persist-worker, history, auth), NATS 2.12 + JetStream, PostgreSQL, React/nats.ws, Prometheus/Grafana.

---

## Scope and Non-Goals

### In scope

- New durable subject namespace (`chat.msg.*`) and stream wiring.
- Fanout routing update from `chat.*` → `chat.msg.*`.
- Persist worker consumer cutover to new durable stream.
- Permission/config/documentation updates.
- Metrics and rollout runbook for safe migration.

### Out of scope (this plan)

- Changing client-facing notify contract (`room.notify.*`, `msg.get`).
- Full multi-cluster NATS split.
- Large schema redesign beyond required persistence compatibility.

---

## Phase 0 — Readiness and Baselines

### Task 0.1: Define migration flags and operational toggles

**Files:**
- Modify: `services/fanout/main.go`
- Modify: `services/persist-worker/main.go`

**Add env flags:**
- `DUAL_WRITE_ENABLED` (default `true` during migration)
- `DURABLE_SUBJECT_PREFIX` (default `chat.msg`)
- `PERSIST_STREAM_NAME` (default `CHAT_DURABLE`)
- `PERSIST_LEGACY_STREAM_NAME` (default `CHAT_MESSAGES`)

**Acceptance criteria:**
- Services log effective migration config at startup.
- Flags are backward compatible with current behavior when unset.

### Task 0.2: Add baseline dashboards/queries before cutover

**Files:**
- Modify: `observability/grafana/provisioning/dashboards/nats-chat-messages.json`
- Modify: `observability/prometheus/recording-rules.yaml`

**Add panels/rules for:**
- Persist-worker consumer lag
- Redeliveries/min
- Ack latency p95/p99
- `msg.get` error rate

**Acceptance criteria:**
- Baseline metrics are visible before any routing changes.

---

## Phase 1 — Introduce Durable Namespace + Stream (No Behavior Change Yet)

### Task 1.1: Create `CHAT_DURABLE` stream in persist-worker startup

**Files:**
- Modify: `services/persist-worker/main.go`

**Implementation steps:**
1. Add stream `CHAT_DURABLE` with subjects:
   - `chat.msg.*`
   - `chat.msg.*.thread.*`
   - `chat.msg.dm.*`
2. Keep existing `CHAT_MESSAGES` stream creation for migration window.
3. Add clear logs showing stream names and subject filters.

**Acceptance criteria:**
- Service starts with both stream configs available.
- No change to current persisted message volume yet.

### Task 1.2: Add helper mapping for durable chat subject

**Files:**
- Modify: `services/fanout/main.go`

**Implementation steps:**
1. Add a helper that maps ingress `deliver.{u}.send.{room}[.thread.{id}]` to:
   - legacy: `chat.{room}[.thread.{id}]`
   - durable: `chat.msg.{room}[.thread.{id}]`
2. Unit-test the mapper using table-driven tests.

**Acceptance criteria:**
- Deterministic subject mapping for room/thread/DM cases.
- Existing behavior unchanged until dual write is enabled.

### Task 1.3: Permission comments/config prep

**Files:**
- Modify: `services/auth/permissions.json`
- Modify: `services/auth/permissions.go` (comments only, if needed)

**Implementation steps:**
1. Keep clients publishing to `deliver.{username}.send.>`.
2. Document that `chat.msg.*` is service-only publish path.
3. Ensure user/admin grants are not expanded to direct `chat.msg.*` publish.

**Acceptance criteria:**
- No client permission regression.
- Security boundary remains fanout-mediated ingress.

---

## Phase 2 — Dual Write in Fanout

### Task 2.1: Enable fanout dual publish (legacy + durable)

**Files:**
- Modify: `services/fanout/main.go`

**Implementation steps:**
1. In ingest handler, publish to legacy `chat.*` (current path).
2. If `DUAL_WRITE_ENABLED=true`, additionally publish same payload to `chat.msg.*`.
3. Add counters:
   - `fanout_publish_legacy_total`
   - `fanout_publish_durable_total`
   - `fanout_publish_dualwrite_errors_total`
4. Keep notify/KV/msg.get path unchanged.

**Acceptance criteria:**
- Dual write active with parity counters.
- No change to client contracts.

### Task 2.2: Add dedupe guidance for downstream consumers

**Files:**
- Modify: `docs/plans/2026-03-23-dual-plane-nats-design.md`
- Modify: `docs/plans/2026-03-23-dual-plane-nats-implementation.md` (this file)

**Implementation steps:**
1. Document that only one stream should feed persist-worker at a time to avoid duplicates.
2. Keep idempotency keys (`room`,`timestamp`,`user`) explicit in docs.

**Acceptance criteria:**
- Rollout docs unambiguous about duplication risks.

---

## Phase 3 — Persist Worker Cutover to `CHAT_DURABLE`

### Task 3.1: Consumer switch flag

**Files:**
- Modify: `services/persist-worker/main.go`

**Implementation steps:**
1. Add logic to choose consumer stream:
   - migration default: legacy stream
   - cutover: durable stream
2. Ensure durable consumer config uses:
   - `AckExplicit`
   - `DeliverAll`
3. Keep existing retry/NAK behavior unchanged.

**Acceptance criteria:**
- Controlled stream cutover by env var.
- No code-path divergence in DB write semantics.

### Task 3.2: Validate parity during cutover window

**Files:**
- No code (runbook + commands)

**Runbook checks:**
- Compare writes/min before vs after cutover.
- Ensure consumer lag remains near zero.
- Ensure redelivery spikes are transient and bounded.

**Acceptance criteria:**
- 24h stable run with no data-loss indicators.

---

## Phase 4 — Decommission Legacy Durable Subjects

### Task 4.1: Disable legacy write in fanout

**Files:**
- Modify: `services/fanout/main.go`

**Implementation steps:**
1. Set legacy publish path behind `LEGACY_CHAT_PUBLISH_ENABLED`.
2. After stable cutover, disable legacy path.
3. Keep ability to rollback by re-enabling for one release cycle.

**Acceptance criteria:**
- Durable path is `chat.msg.*` only.
- Rollback switch documented and tested.

### Task 4.2: Retire/trim old stream bindings

**Files:**
- Modify: `services/persist-worker/main.go` (remove legacy stream create once retired)
- Modify: `docs/plans/2026-03-23-dual-plane-nats-design.md`

**Acceptance criteria:**
- Legacy stream dependencies removed after final sign-off.

---

## Phase 5 — Testing and Verification

### Task 5.1: Unit tests

**Files:**
- Modify/Create: `services/fanout/*_test.go`
- Modify/Create: `services/persist-worker/*_test.go`

**Coverage targets:**
- Subject mapping legacy vs durable.
- DM/thread subject generation edge cases.
- Persist worker `roomFromSubject` compatibility for both namespaces.

### Task 5.2: Integration smoke tests

**Commands (examples):**
- bring up stack
- publish sample room/thread/DM messages
- verify DB rows and history API responses
- verify notify + msg.get still function

### Task 5.3: Load/regression validation

**Files:**
- Modify: `load-tests/scenarios/large-room.js` (optional subject overrides)

**Checks:**
- publish throughput vs baseline
- end-to-end latency p95
- message loss under reconnect wave

---

## Operational Rollout Playbook

1. Deploy Phase 1 code (no behavioral change).
2. Enable `DUAL_WRITE_ENABLED=true`.
3. Observe parity metrics for 24h.
4. Switch persist-worker read stream to `CHAT_DURABLE`.
5. Observe lag/errors for 24h.
6. Disable legacy publish path.
7. Remove legacy stream dependencies after one stable release.

Rollback at any step:
- revert persist-worker stream selector to legacy
- re-enable legacy publish toggle

---

## Risk Register

- **Duplicate persistence during dual-write:** avoid by consuming only one stream in persist-worker at a time.
- **Subject mismatch bugs:** mitigate with mapper unit tests + canary publish checks.
- **Metric blind spots during migration:** mitigate with Phase 0 dashboards before behavior changes.
- **Permission drift:** keep client publish ingress unchanged (`deliver.*.send.>` only).

---

## Definition of Done

- Durable chat traffic published to `chat.msg.*`.
- Persist-worker consumes `CHAT_DURABLE` in production.
- Notify + `msg.get` contracts unchanged for clients.
- Dashboards/alerts cover lag, redelivery, ack latency, and fetch errors.
- Legacy durable publish path disabled (or explicitly flagged for rollback-only).
- Runbook documented and validated by staging rehearsal.
