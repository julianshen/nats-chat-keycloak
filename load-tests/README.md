# Load Tests

k6 load tests for the NATS chat system, targeting two extreme scenarios:

| Scenario | What it stresses | Key metric |
|----------|-----------------|------------|
| **Large Room** | 10K+ members in one room | Message multicast latency |
| **Many Rooms** | 1 user in 5K rooms | Subscription routing overhead |

## Prerequisites

- **k6** installed (`brew install k6` or [k6.io/docs/get-started](https://k6.io/docs/get-started/installation/))
- **Docker Compose** stack running (`docker compose up -d --build`)
- **jq** for the provisioning script (`brew install jq`)

## Quick Start

```bash
# 1. Provision test users in Keycloak (one-time, creates loadtest-0001..10000)
./setup/provision-users.sh 10000

# 2. Run large-room scenario (smoke test: 100 members)
k6 run --env LARGE_ROOM_MEMBERS=100 scenarios/large-room.js

# 3. Run many-rooms scenario (smoke test: 50 rooms)
k6 run --env MANY_ROOMS_COUNT=50 --env MANY_ROOMS_PUBLISHERS=5 \
       scenarios/many-rooms.js
```

## Scenarios

### Scenario 1: Large Room (`scenarios/large-room.js`)

Simulates a room with 10K+ concurrent members. Tests NATS multicast
(`room.msg.{room}`) and fanout service throughput.

```
┌─────────┐   chat.{room}   ┌─────────┐  room.msg.{room}  ┌──────────┐
│ 10 pubs ├─────────────────►│ fanout  ├──────────────────►│ 10K subs │
│  (VUs)  │                  │ service │  NATS multicast   │  (VUs)   │
└─────────┘                  └─────────┘                   └──────────┘
```

**Phases:**
1. **Ramp-up** (5 min): Gradually connect 10K VUs, each joins room
2. **Steady state** (10 min): 10 publishers send 1 msg/sec each → 10 msg/sec fanout
3. **Ramp-down** (2 min): Graceful disconnect

**Thresholds:**
- p95 receive latency < 500ms
- p99 receive latency < 2000ms
- NATS errors < 100

```bash
# Full run
k6 run scenarios/large-room.js

# Custom sizing
k6 run --env LARGE_ROOM_MEMBERS=5000 \
       --env LARGE_ROOM_PUBLISHERS=20 \
       --env LARGE_ROOM_MSG_INTERVAL_MS=500 \
       scenarios/large-room.js

# With JSON output for report generation
k6 run --out json=results-large-room.json scenarios/large-room.js
```

### Scenario 2: Many Rooms (`scenarios/many-rooms.js`)

Simulates one user subscribed to 5K rooms (10K+ NATS subscriptions).
Tests NATS subscription table performance and message routing.

```
               ┌────────────────────────────────────────────┐
               │ subscriber (1 VU) — loadtest-0001          │
               │  • 5K × room.msg.{room}  subscriptions     │
               │  • 5K × room.presence.{room} subscriptions │
               │  • 1  × deliver.{user}.>  subscription     │
               │  = 10,001 total subscriptions               │
               └──────────────────┬─────────────────────────┘
                                  │ receives
               ┌──────────────────┴─────────────────────────┐
               │ 50 publisher VUs                            │
               │  • Each picks random room from 5K set       │
               │  • Publishes chat.{room} at 1 msg/sec       │
               └────────────────────────────────────────────┘
```

**Phases:**
1. **Join phase** (0–3 min): Subscriber joins 5K rooms in batches of 100
2. **Publisher ramp-up** (3–5 min): 50 publishers connect
3. **Steady state** (5–13 min): Publishers send to random rooms
4. **Ramp-down** (13–14 min): Publishers disconnect

**Thresholds:**
- p95 receive latency < 1000ms
- p99 receive latency < 3000ms
- Average room join < 50ms

```bash
# Full run
k6 run scenarios/many-rooms.js

# Custom sizing
k6 run --env MANY_ROOMS_COUNT=1000 \
       --env MANY_ROOMS_PUBLISHERS=20 \
       scenarios/many-rooms.js
```

## Configuration

All parameters are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NATS_WS_URL` | `ws://localhost:9222` | NATS WebSocket endpoint |
| `KEYCLOAK_TOKEN_URL` | `http://localhost:8080/realms/nats-chat/protocol/openid-connect/token` | Token endpoint |
| `KEYCLOAK_CLIENT_ID` | `nats-chat-app` | OIDC client ID |
| `USER_PREFIX` | `loadtest-` | Username prefix |
| `USER_PASSWORD` | `loadtest123` | Password for all test users |
| `LARGE_ROOM_MEMBERS` | `10000` | VUs for large-room scenario |
| `LARGE_ROOM_PUBLISHERS` | `10` | Publishing VUs |
| `LARGE_ROOM_MSG_INTERVAL_MS` | `1000` | Publish interval per publisher |
| `MANY_ROOMS_COUNT` | `5000` | Rooms for many-rooms scenario |
| `MANY_ROOMS_PUBLISHERS` | `50` | Publisher VUs |

## Provisioning Users

The setup script creates users `loadtest-0001` through `loadtest-{N}` in
Keycloak with the `user` realm role:

```bash
# Create 10,000 users (default)
./setup/provision-users.sh

# Create 500 users (faster, for smoke tests)
./setup/provision-users.sh 500

# Custom Keycloak URL
KEYCLOAK_URL=http://keycloak:8080 ./setup/provision-users.sh 10000
```

Users are idempotent — re-running skips existing users.

## Interpreting Results

### Key Metrics

| Metric | What it measures |
|--------|-----------------|
| `msg_receive_latency` | End-to-end: publish timestamp → receive time |
| `nats_connect_duration` | WebSocket open → NATS CONNECT handshake |
| `room_join_duration` | Time to publish `room.join.*` |
| `msgs_received` | Total messages received across all VUs |
| `msgs_published` | Total messages published |
| `active_connections` | Current open WebSocket connections |
| `subscription_count` | NATS subscriptions (many-rooms) |
| `join_phase_duration` | Time to join all 5K rooms (many-rooms) |

### What to Watch

- **`msg_receive_latency` p99 spikes** → NATS server or fanout service saturated
- **`nats_errors` climbing** → auth callout failures, permission denials, or connection drops
- **`nats_connect_duration` > 5s** → auth service or Keycloak under pressure
- **`active_connections` not reaching target** → connection failures during ramp-up

### System Metrics to Correlate

While k6 runs, monitor server-side:

```bash
# NATS server stats
curl http://localhost:8222/varz | jq '{connections, subscriptions, in_msgs, out_msgs, mem}'

# NATS per-connection details
curl http://localhost:8222/connz?subs=true | jq '.connections | length'

# Docker container stats
docker stats --no-stream
```

## Architecture Notes

The tests implement the NATS text protocol directly over k6 WebSocket
(`lib/nats-ws.js`), sending binary frames containing protocol commands:

```
INFO → CONNECT {token: "..."} → SUB/PUB/MSG/HMSG → PING/PONG
```

This matches the real `nats.ws` client behavior. The NATS auth callout
validates each connection's Keycloak JWT, so every VU goes through the
full authentication pipeline.
