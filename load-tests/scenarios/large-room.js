/**
 * Scenario 1 — Large Room: 10K+ members in a single room
 *
 * What it tests:
 *   - NATS multicast scalability (room.msg.{room} with 10K subscribers)
 *   - Fanout service throughput (chat.> → room.msg.{room})
 *   - Room-service KV join throughput (10K kv.Create calls)
 *   - Auth callout under concurrent connection storm
 *   - End-to-end message delivery latency at scale
 *
 * Flow per VU:
 *   1. Get Keycloak token (batched in setup)
 *   2. Connect to NATS via WebSocket
 *   3. Subscribe to room.msg.{room}, room.presence.{room}, deliver.{user}.>
 *   4. Publish room.join.{room}
 *   5. First N VUs publish chat.{room} messages periodically
 *   6. All VUs measure receive latency (timestamp embedded in payload)
 *
 * Usage:
 *   # Quick smoke test (100 members)
 *   k6 run --env LARGE_ROOM_MEMBERS=100 scenarios/large-room.js
 *
 *   # Full 10K test
 *   k6 run scenarios/large-room.js
 *
 *   # With JSON output for reports
 *   k6 run --out json=results-large-room.json scenarios/large-room.js
 */

import { Counter, Trend, Gauge } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { CONFIG } from '../lib/config.js';
import { connectNats } from '../lib/nats-ws.js';
import { batchGetTokens } from '../lib/auth.js';

// ── Custom metrics ──────────────────────────────────────────────

const msgReceiveLatency = new Trend('msg_receive_latency', true);
const msgsReceived = new Counter('msgs_received');
const msgsPublished = new Counter('msgs_published');
const roomJoinDuration = new Trend('room_join_duration', true);
const activeConnections = new Gauge('active_connections');

// ── Constants ───────────────────────────────────────────────────

const ROOM = CONFIG.LARGE_ROOM_NAME;
const TOTAL_MEMBERS = CONFIG.LARGE_ROOM_MEMBERS;
const NUM_PUBLISHERS = CONFIG.LARGE_ROOM_PUBLISHERS;
const MSG_INTERVAL = CONFIG.LARGE_ROOM_MSG_INTERVAL_MS;

// Test duration: ramp-up + steady + ramp-down
const RAMP_UP = CONFIG.RAMP_UP_DURATION;
const STEADY = CONFIG.STEADY_STATE_DURATION;
const RAMP_DOWN = CONFIG.RAMP_DOWN_DURATION;

// How long each VU keeps its WebSocket open (must exceed total test time)
// VUs that start during ramp-up stay connected through steady state
const WS_DURATION_MS = 20 * 60 * 1000; // 20 minutes max

// ── k6 options ──────────────────────────────────────────────────

export const options = {
  scenarios: {
    members: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: TOTAL_MEMBERS },
        { duration: STEADY, target: TOTAL_MEMBERS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    msg_receive_latency: ['p(95)<500', 'p(99)<2000'],
    nats_errors: ['count<100'],
    nats_connect_duration: ['p(95)<5000'],
  },
};

// ── Setup: batch-fetch Keycloak tokens ──────────────────────────

export function setup() {
  console.log(
    'Fetching tokens for ' + TOTAL_MEMBERS + ' users (' +
    CONFIG.USER_PREFIX + '0001 .. ' + CONFIG.USER_PREFIX +
    String(TOTAL_MEMBERS).padStart(4, '0') + ')...'
  );
  const creds = batchGetTokens(1, TOTAL_MEMBERS);
  console.log('Got ' + creds.length + ' tokens');
  return { creds };
}

// ── Default VU function ─────────────────────────────────────────

export default function (data) {
  const vuIndex = (__VU - 1) % data.creds.length;
  const cred = data.creds[vuIndex];
  if (!cred || !cred.token) return; // skip if token failed

  const username = cred.username;
  const isPublisher = vuIndex < NUM_PUBLISHERS;
  const memberKey = ROOM; // public room, memberKey = room name

  activeConnections.add(1);

  connectNats(CONFIG.NATS_WS_URL, cred.token, {
    onReady: function (api) {
      // 1. Subscribe to per-room multicast
      api.subscribe('room.msg.' + memberKey, function (_subject, payload) {
        try {
          const msg = JSON.parse(payload);
          if (msg.timestamp) {
            const latency = Date.now() - msg.timestamp;
            msgReceiveLatency.add(latency);
          }
          msgsReceived.add(1);
        } catch (e) { /* ignore malformed */ }
      });

      // 2. Subscribe to presence diffs (to keep subscription realistic)
      api.subscribe('room.presence.' + memberKey, function () {});

      // 3. Subscribe to per-user deliver subject (threads, apps, etc.)
      api.subscribe('deliver.' + username + '.>', function () {});

      // 4. Join room
      const joinStart = Date.now();
      api.publish('room.join.' + memberKey, { userId: username });
      roomJoinDuration.add(Date.now() - joinStart);

      // 5. Start heartbeat (presence)
      const connId = 'k6-' + __VU + '-' + Date.now();
      api.publish('presence.heartbeat', { userId: username, connId: connId });
      api.socket.setInterval(function () {
        api.publish('presence.heartbeat', { userId: username, connId: connId });
      }, 10000);

      // 6. Publisher VUs send messages periodically
      if (isPublisher) {
        api.socket.setInterval(function () {
          api.publish('chat.' + ROOM, {
            user: username,
            text: 'Load test message from ' + username + ' at ' + Date.now(),
            room: ROOM,
            timestamp: Date.now(),
          });
          msgsPublished.add(1);
        }, MSG_INTERVAL);
      }
    },
    onClose: function () {
      activeConnections.add(-1);
    },
  }, WS_DURATION_MS);
}

// ── Teardown ────────────────────────────────────────────────────

export function teardown(data) {
  console.log('Large room test complete. ' + data.creds.length + ' users tested.');
}
