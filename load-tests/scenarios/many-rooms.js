/**
 * Scenario 2 — Many Rooms: one user subscribed to 5K rooms
 *
 * What it tests:
 *   - NATS subscription scalability (10K+ subs per connection:
 *     5K room.msg.* + 5K room.presence.* + 1 deliver.>)
 *   - Room-service KV join throughput (5K sequential joins)
 *   - Message routing latency with massive subscription table
 *   - Fanout service cache behavior across many rooms
 *   - Memory footprint per connection on NATS server
 *
 * Architecture:
 *   Two k6 scenarios run concurrently:
 *
 *   "subscriber" (1 VU):
 *     - Connects to NATS as the target user
 *     - Joins 5K rooms (room.msg.* + room.presence.* per room)
 *     - Measures message receive latency across all rooms
 *
 *   "publishers" (N VUs):
 *     - Each connects as a separate user
 *     - Publishes messages to random rooms from the 5K set
 *     - Measures publish throughput
 *
 * Usage:
 *   # Quick smoke test (50 rooms)
 *   k6 run --env MANY_ROOMS_COUNT=50 --env MANY_ROOMS_PUBLISHERS=5 \
 *          scenarios/many-rooms.js
 *
 *   # Full 5K rooms test
 *   k6 run scenarios/many-rooms.js
 *
 *   # With JSON output
 *   k6 run --out json=results-many-rooms.json scenarios/many-rooms.js
 */

import { Counter, Trend, Gauge } from 'k6/metrics';
import { CONFIG } from '../lib/config.js';
import { connectNats } from '../lib/nats-ws.js';
import { getToken, batchGetTokens } from '../lib/auth.js';

// ── Custom metrics ──────────────────────────────────────────────

const msgReceiveLatency = new Trend('msg_receive_latency', true);
const msgsReceived = new Counter('msgs_received');
const msgsPublished = new Counter('msgs_published');
const roomJoinDuration = new Trend('room_join_duration', true);
const roomsJoined = new Counter('rooms_joined');
const subscriptionCount = new Gauge('subscription_count');
const joinPhaseComplete = new Trend('join_phase_duration', true);

// ── Constants ───────────────────────────────────────────────────

const NUM_ROOMS = CONFIG.MANY_ROOMS_COUNT;
const ROOM_PREFIX = CONFIG.MANY_ROOMS_PREFIX;
const NUM_PUBLISHERS = CONFIG.MANY_ROOMS_PUBLISHERS;
const MSG_INTERVAL = CONFIG.MANY_ROOMS_MSG_INTERVAL_MS;

// Target user is loadtest-0001; publishers are loadtest-0002..N+1
const TARGET_USER = CONFIG.USER_PREFIX + '0001';
const TARGET_PASS = CONFIG.USER_PASSWORD;

// Subscriber keeps connection for full duration; publishers join later
const SUB_DURATION_MS = 25 * 60 * 1000; // 25 min max
const PUB_DURATION_MS = 15 * 60 * 1000; // 15 min max

// Batch size for room joins (avoid flooding NATS)
const JOIN_BATCH = 100;
const JOIN_BATCH_DELAY_MS = 200; // pause between batches

// ── Room name generator ─────────────────────────────────────────

function roomName(i) {
  return ROOM_PREFIX + String(i).padStart(5, '0');
}

// ── k6 options ──────────────────────────────────────────────────

export const options = {
  scenarios: {
    subscriber: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'subscriber',
      maxDuration: '30m',
    },
    publishers: {
      executor: 'ramping-vus',
      exec: 'publisher',
      startVUs: 0,
      stages: [
        // Wait 3 min for subscriber to finish joining, then ramp up
        { duration: '2m', target: NUM_PUBLISHERS },
        { duration: '10m', target: NUM_PUBLISHERS },
        { duration: '1m', target: 0 },
      ],
      // Delay start so subscriber has time to join rooms
      startTime: '3m',
    },
  },
  thresholds: {
    msg_receive_latency: ['p(95)<1000', 'p(99)<3000'],
    nats_errors: ['count<50'],
    room_join_duration: ['avg<50'],
  },
};

// ── Setup: get tokens ───────────────────────────────────────────

export function setup() {
  // Token for the target subscriber
  console.log('Getting token for target subscriber: ' + TARGET_USER);
  const subToken = getToken(TARGET_USER, TARGET_PASS);
  if (!subToken) {
    console.error('Failed to get subscriber token — aborting');
    return { subToken: null, pubCreds: [] };
  }

  // Tokens for publishers (loadtest-0002 .. loadtest-{NUM_PUBLISHERS+1})
  console.log('Fetching tokens for ' + NUM_PUBLISHERS + ' publishers...');
  const pubCreds = batchGetTokens(2, NUM_PUBLISHERS + 1);
  console.log('Got ' + pubCreds.length + ' publisher tokens');

  return { subToken, pubCreds };
}

// ── Subscriber VU: join 5K rooms ────────────────────────────────

export function subscriber(data) {
  if (!data.subToken) return;

  const username = TARGET_USER;
  const connId = 'k6-sub-' + Date.now();

  connectNats(CONFIG.NATS_WS_URL, data.subToken, {
    onReady: function (api) {
      // 1. Per-user deliver subscription
      api.subscribe('deliver.' + username + '.>', function () {});
      let subCount = 1;

      // 2. Join rooms in batches
      const joinStartTime = Date.now();
      let roomsToJoin = NUM_ROOMS;
      let currentRoom = 1;

      function joinBatch() {
        const batchEnd = Math.min(currentRoom + JOIN_BATCH - 1, NUM_ROOMS);

        for (let i = currentRoom; i <= batchEnd; i++) {
          const room = roomName(i);
          const memberKey = room;

          // Subscribe to room multicast + presence
          api.subscribe('room.msg.' + memberKey, function (_subject, payload) {
            try {
              const msg = JSON.parse(payload);
              if (msg.timestamp) {
                msgReceiveLatency.add(Date.now() - msg.timestamp);
              }
              msgsReceived.add(1);
            } catch (e) { /* ignore */ }
          });
          api.subscribe('room.presence.' + memberKey, function () {});
          subCount += 2;

          // Publish join
          const t0 = Date.now();
          api.publish('room.join.' + memberKey, { userId: username });
          roomJoinDuration.add(Date.now() - t0);
          roomsJoined.add(1);
        }

        subscriptionCount.add(subCount);
        currentRoom = batchEnd + 1;

        if (currentRoom <= NUM_ROOMS) {
          // Schedule next batch
          api.socket.setTimeout(joinBatch, JOIN_BATCH_DELAY_MS);
        } else {
          // All rooms joined
          const elapsed = Date.now() - joinStartTime;
          joinPhaseComplete.add(elapsed);
          console.log(
            'Subscriber joined ' + NUM_ROOMS + ' rooms (' +
            subCount + ' subscriptions) in ' + (elapsed / 1000).toFixed(1) + 's'
          );
        }
      }

      // Start joining
      joinBatch();

      // 3. Heartbeat
      api.publish('presence.heartbeat', { userId: username, connId: connId });
      api.socket.setInterval(function () {
        api.publish('presence.heartbeat', { userId: username, connId: connId });
      }, 10000);
    },
    onClose: function () {
      console.log('Subscriber disconnected');
    },
  }, SUB_DURATION_MS);
}

// ── Publisher VUs: send messages to random rooms ────────────────

export function publisher(data) {
  const vuIndex = (__VU - 1) % data.pubCreds.length;
  const cred = data.pubCreds[vuIndex];
  if (!cred || !cred.token) return;

  const username = cred.username;
  const connId = 'k6-pub-' + __VU + '-' + Date.now();

  connectNats(CONFIG.NATS_WS_URL, cred.token, {
    onReady: function (api) {
      // Deliver subscription (required by permissions)
      api.subscribe('deliver.' + username + '.>', function () {});

      // Heartbeat
      api.publish('presence.heartbeat', { userId: username, connId: connId });
      api.socket.setInterval(function () {
        api.publish('presence.heartbeat', { userId: username, connId: connId });
      }, 10000);

      // Publish messages to random rooms
      api.socket.setInterval(function () {
        // Pick a random room from the 5K set
        const roomIdx = Math.floor(Math.random() * NUM_ROOMS) + 1;
        const room = roomName(roomIdx);
        const memberKey = room;

        // Join the room first (idempotent — room-service ignores duplicates)
        api.publish('room.join.' + memberKey, { userId: username });

        // Publish chat message
        api.publish('chat.' + room, {
          user: username,
          text: 'Load test msg to ' + room,
          room: room,
          timestamp: Date.now(),
        });
        msgsPublished.add(1);
      }, MSG_INTERVAL);
    },
    onClose: function () {},
  }, PUB_DURATION_MS);
}

// ── Teardown ────────────────────────────────────────────────────

export function teardown(data) {
  console.log(
    'Many-rooms test complete. Rooms: ' + NUM_ROOMS +
    ', Publishers: ' + data.pubCreds.length
  );
}
