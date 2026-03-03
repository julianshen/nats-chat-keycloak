/**
 * Scenario 3 — Reconnect waves
 *
 * What it tests:
 *   - Recovery behavior when 5–10% of clients disconnect/reconnect periodically
 *   - Subscription restoration latency after reconnect
 *   - End-to-end receive latency during reconnect churn
 *
 * Model:
 *   - Stable clients stay connected for full test duration
 *   - Wave clients reconnect every wave period (e.g. every 60s)
 *   - Publishers continuously publish to one hot room so recovery can be measured
 */

import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { CONFIG } from '../lib/config.js';
import { connectNats } from '../lib/nats-ws.js';
import { batchGetTokens } from '../lib/auth.js';

const msgReceiveLatency = new Trend('msg_receive_latency', true);
const reconnectRecovery = new Trend('reconnect_recovery_ms', true);
const reconnectEvents = new Counter('reconnect_events');
const msgsPublished = new Counter('msgs_published');
const msgsReceived = new Counter('msgs_received');
const msgGetFailures = new Counter('msg_get_failures');

const TOTAL_CLIENTS = CONFIG.RECONNECT_TOTAL_CLIENTS;
const WAVE_PERCENT = CONFIG.RECONNECT_WAVE_PERCENT;
const WAVE_CLIENTS = Math.max(1, Math.floor(TOTAL_CLIENTS * (WAVE_PERCENT / 100)));
const STABLE_CLIENTS = Math.max(0, TOTAL_CLIENTS - WAVE_CLIENTS);
const PUBLISHERS = Math.min(CONFIG.RECONNECT_PUBLISHERS, STABLE_CLIENTS > 0 ? STABLE_CLIENTS : WAVE_CLIENTS);

const ROOM = CONFIG.RECONNECT_ROOM;
const WAVE_PERIOD_SEC = CONFIG.RECONNECT_WAVE_PERIOD_SEC;
const DOWNTIME_SEC = CONFIG.RECONNECT_DOWNTIME_SEC;
const WAVES = CONFIG.RECONNECT_WAVES;
const MSG_INTERVAL = CONFIG.RECONNECT_MSG_INTERVAL_MS;

const CONNECT_MS = Math.max(1000, (WAVE_PERIOD_SEC - DOWNTIME_SEC) * 1000);
const TOTAL_DURATION_SEC = WAVE_PERIOD_SEC * WAVES;

export const options = {
  scenarios: {
    stable_clients: {
      executor: 'constant-vus',
      exec: 'stableClient',
      vus: STABLE_CLIENTS,
      duration: `${TOTAL_DURATION_SEC}s`,
    },
    wave_clients: {
      executor: 'per-vu-iterations',
      exec: 'waveClient',
      vus: WAVE_CLIENTS,
      iterations: WAVES,
      maxDuration: `${TOTAL_DURATION_SEC + 120}s`,
    },
  },
  thresholds: {
    reconnect_recovery_ms: ['p(95)<60000'],
    msg_receive_latency: ['p(95)<2000', 'p(99)<5000'],
    nats_errors: ['count<200'],
    msg_get_failures: ['count<50'],
  },
};

export function setup() {
  // +5 buffer for retries/manual testing
  const creds = batchGetTokens(1, TOTAL_CLIENTS + 5);
  return { creds };
}

function runConnection(cred, isPublisher, durationMs, isReconnectAttempt) {
  if (!cred || !cred.token) {
    return;
  }

  const username = cred.username;
  const connectStartedAt = Date.now();
  const connId = `k6-rw-${username}-${Date.now()}`;

  connectNats(CONFIG.NATS_WS_URL, cred.token, {
    onReady: function (api) {
      let firstMessageSeen = false;

      // Required subscriptions
      api.subscribe('deliver.' + username + '.>', function () {});
      api.subscribe('room.notify.' + ROOM, function (_subject, payload) {
        try {
          const notification = JSON.parse(payload);
          if (!notification.notifyId) {
            return;
          }

          api.request('msg.get', { notifyId: notification.notifyId, room: ROOM }, 5000, function (replyData) {
            try {
              const fullMsg = JSON.parse(replyData);
              if (fullMsg.error) {
                msgGetFailures.add(1);
                return;
              }
              if (fullMsg.timestamp) {
                msgReceiveLatency.add(Date.now() - fullMsg.timestamp);
              }
              if (!firstMessageSeen) {
                firstMessageSeen = true;
                if (isReconnectAttempt) {
                  reconnectRecovery.add(Date.now() - connectStartedAt);
                }
              }
              msgsReceived.add(1);
            } catch (_replyErr) {
              msgGetFailures.add(1);
            }
          });
        } catch (_e) {
          // ignore malformed payloads
        }
      });
      api.subscribe('room.presence.' + ROOM, function () {});

      // Join room and maintain presence
      api.publish('room.join.' + ROOM, { userId: username });
      api.publish('presence.heartbeat', { userId: username, connId: connId });
      api.socket.setInterval(function () {
        api.publish('presence.heartbeat', { userId: username, connId: connId });
      }, 10000);

      // Optional publisher role
      if (isPublisher) {
        api.socket.setInterval(function () {
          api.publish('chat.' + ROOM, {
            user: username,
            room: ROOM,
            text: 'reconnect wave message',
            timestamp: Date.now(),
          });
          msgsPublished.add(1);
        }, MSG_INTERVAL);
      }
    },
  }, durationMs);
}

export function stableClient(data) {
  const idx = __VU - 1;
  const cred = data.creds[idx];
  const isPublisher = idx < PUBLISHERS;
  runConnection(cred, isPublisher, TOTAL_DURATION_SEC * 1000, false);
}

export function waveClient(data) {
  const idx = STABLE_CLIENTS + (__VU - 1);
  const cred = data.creds[idx];

  const isReconnectAttempt = __ITER > 0;
  if (isReconnectAttempt) {
    reconnectEvents.add(1);
  }

  runConnection(cred, false, CONNECT_MS, isReconnectAttempt);
  sleep(DOWNTIME_SEC);
}

export function teardown() {
  console.log(
    `Reconnect-wave complete: clients=${TOTAL_CLIENTS}, wave_clients=${WAVE_CLIENTS}, waves=${WAVES}`
  );
}
