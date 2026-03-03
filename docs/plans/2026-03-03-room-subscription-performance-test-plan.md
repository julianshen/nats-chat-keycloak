# Room Subscription Performance Test Plan (Execution-Ready)

## Goal

Validate two product limits with measurable pass/fail outcomes:

1. **Per-user room membership:** up to **5,000 rooms**.
2. **Per-room membership:** up to **10,000 members**.

This repository already has k6 scenarios for both axes (`load-tests/scenarios/many-rooms.js` and `load-tests/scenarios/large-room.js`). This plan turns them into an execution checklist with explicit acceptance criteria.

---

## Key question: is subscribing 5,000 rooms at init heavy?

**Yes — heavy if done eagerly.**

Why:

- Current client model subscribes per room to `room.notify.{room}` and `room.presence.{room}` plus per-user `deliver.{user}.>`.
- At 5,000 rooms, one client can hold ~**10,001+ subscriptions** (not counting `_INBOX`).
- This increases startup CPU, memory, and reconnect recovery time.

**Recommendation:** keep logical membership at 5,000, but do **active-window/lazy subscriptions** (e.g., subscribe only active 50–200 rooms on init; batch the rest on-demand).

---

## Test scope

### In scope

- NATS/WebSocket connection behavior under high subscription cardinality.
- Room join throughput at scale.
- Message and notification delivery latency.
- Reconnect recovery when many subscriptions must be restored.

### Out of scope

- UI visual correctness.
- Business semantics unrelated to scale (permissions, moderation workflows).

---

## Environment baseline

- Dedicated load-test environment only (no shared dev stack).
- Docker compose services healthy.
- Observability on: Prometheus + Grafana + OTel.
- Keycloak seeded with test users.

### Setup commands

```bash
# Start stack
 docker compose up -d --build

# Provision users (example: 10,000)
 ./load-tests/setup/provision-users.sh 10000
```

---

## Metrics and pass criteria

## A) Many-rooms (5,000 rooms for one user)

**Primary risks:** initialization burst, subscription table pressure, reconnect storm.

Collect:

- Time to complete join+subscribe phase.
- Browser/client memory (if browser-run), k6 connection error rate.
- p95/p99 message receive latency.
- NATS memory and subscription cardinality growth.

Pass criteria:

- p95 receive latency `< 1000ms`.
- p99 receive latency `< 3000ms`.
- No sustained reconnect loop.
- No slow-consumer storm.

Run:

```bash
cd load-tests
k6 run --env MANY_ROOMS_COUNT=5000 --env MANY_ROOMS_PUBLISHERS=50 scenarios/many-rooms.js
```

Smoke first:

```bash
cd load-tests
k6 run --env MANY_ROOMS_COUNT=500 --env MANY_ROOMS_PUBLISHERS=10 scenarios/many-rooms.js
```

## B) Large-room (10,000 members in one room)

**Primary risks:** fanout throughput, delivery latency, ingress/egress bottlenecks.

Collect:

- p95/p99 message receive latency.
- Fanout throughput and error counts.
- NATS outbound bytes and CPU.
- Join time during ramp.

Pass criteria:

- p95 receive latency `< 500ms`.
- p99 receive latency `< 2000ms`.
- `nats_errors < 100` for baseline run.

Run:

```bash
cd load-tests
k6 run --env LARGE_ROOM_MEMBERS=10000 --env LARGE_ROOM_PUBLISHERS=10 scenarios/large-room.js
```

Smoke first:

```bash
cd load-tests
k6 run --env LARGE_ROOM_MEMBERS=100 --env LARGE_ROOM_PUBLISHERS=5 scenarios/large-room.js
```

## C) Reconnect recovery (must-have add-on)

Current scripts test steady-state scale but not explicit reconnect waves. Add reconnect test variant:

- 5–10% client disconnect/reconnect every minute for 10 minutes.
- Record time to recover subscriptions and return to steady latency.

Pass criteria:

- Recovery to baseline p95 within 60s per wave.
- No cumulative failure escalation over 10 waves.

---

## Execution plan (1 week)

### Day 1 — Baseline and smoke

- Run smoke for many-rooms and large-room.
- Validate dashboards and metric ingestion.
- Save artifacts:
  - k6 output JSON,
  - Grafana screenshots,
  - environment config snapshot.

### Day 2–3 — Full limit runs

- Run 5k-room scenario (3 repetitions).
- Run 10k-member scenario (3 repetitions).
- Compute median + p95 + worst run.

### Day 4 — Reconnect-wave scenario

- Implement reconnect-wave variant script.
- Run 2 repetitions with same seed/user set.

### Day 5 — Decision report

Produce one report with:

- Which limits pass/fail.
- Top bottlenecks ranked by impact.
- Concrete mitigations with effort estimate.

---

## Required engineering follow-ups if init cost is high

If many-rooms init exceeds SLO or causes instability, implement in order:

1. **Active-window subscriptions** (subscribe only active/recent rooms on startup).
2. **Batch subscribe with backpressure** (e.g., 50 subs per tick).
3. **Reconnect throttling** (jittered resubscribe schedule).
4. **Priority tiers** (active room > unread rooms > dormant rooms).

Success target after optimization:

- 5,000-room member can login without blocking UI responsiveness.
- Reconnect does not trigger multi-second freeze or disconnect loop.

---

## Deliverables checklist

- [ ] `results/many-rooms-smoke.json`
- [ ] `results/many-rooms-full-run-{1..3}.json`
- [ ] `results/large-room-smoke.json`
- [ ] `results/large-room-full-run-{1..3}.json`
- [ ] reconnect-wave script and 2 result files
- [ ] final summary markdown with pass/fail table

---

## Final answer to product question

- **Can the backend be tested for 5,000 rooms/user and 10,000 members/room?** Yes — existing k6 scenarios already map to those constraints; this document defines how to run and judge them.
- **Is subscribing 5,000 rooms on client init heavy?** **Yes**, if eager. Use staged/lazy + batched subscription strategy.
