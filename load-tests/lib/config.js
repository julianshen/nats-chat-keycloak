// Load test configuration — override via environment variables
export const CONFIG = {
  // NATS WebSocket endpoint
  NATS_WS_URL: __ENV.NATS_WS_URL || 'ws://localhost:9222',

  // Keycloak token endpoint (Resource Owner Password Credentials grant)
  KEYCLOAK_TOKEN_URL:
    __ENV.KEYCLOAK_TOKEN_URL ||
    'http://localhost:8080/realms/nats-chat/protocol/openid-connect/token',
  KEYCLOAK_CLIENT_ID: __ENV.KEYCLOAK_CLIENT_ID || 'nats-chat-app',

  // Test user credentials pattern: loadtest-{NNNN} / loadtest123
  USER_PREFIX: __ENV.USER_PREFIX || 'loadtest-',
  USER_PASSWORD: __ENV.USER_PASSWORD || 'loadtest123',

  // Large room scenario
  LARGE_ROOM_NAME: __ENV.LARGE_ROOM_NAME || 'loadtest-large-room',
  LARGE_ROOM_MEMBERS: parseInt(__ENV.LARGE_ROOM_MEMBERS || '10000'),
  LARGE_ROOM_PUBLISHERS: parseInt(__ENV.LARGE_ROOM_PUBLISHERS || '10'),
  LARGE_ROOM_MSG_INTERVAL_MS: parseInt(__ENV.LARGE_ROOM_MSG_INTERVAL_MS || '1000'),

  // Many rooms scenario
  MANY_ROOMS_COUNT: parseInt(__ENV.MANY_ROOMS_COUNT || '5000'),
  MANY_ROOMS_PREFIX: __ENV.MANY_ROOMS_PREFIX || 'loadtest-room-',
  MANY_ROOMS_PUBLISHERS: parseInt(__ENV.MANY_ROOMS_PUBLISHERS || '50'),
  MANY_ROOMS_MSG_INTERVAL_MS: parseInt(__ENV.MANY_ROOMS_MSG_INTERVAL_MS || '1000'),


  // Reconnect-wave scenario
  RECONNECT_ROOM: __ENV.RECONNECT_ROOM || 'loadtest-reconnect-room',
  RECONNECT_TOTAL_CLIENTS: parseInt(__ENV.RECONNECT_TOTAL_CLIENTS || '1000'),
  RECONNECT_WAVE_PERCENT: parseInt(__ENV.RECONNECT_WAVE_PERCENT || '10'),
  RECONNECT_WAVES: parseInt(__ENV.RECONNECT_WAVES || '10'),
  RECONNECT_WAVE_PERIOD_SEC: parseInt(__ENV.RECONNECT_WAVE_PERIOD_SEC || '60'),
  RECONNECT_DOWNTIME_SEC: parseInt(__ENV.RECONNECT_DOWNTIME_SEC || '10'),
  RECONNECT_PUBLISHERS: parseInt(__ENV.RECONNECT_PUBLISHERS || '20'),
  RECONNECT_MSG_INTERVAL_MS: parseInt(__ENV.RECONNECT_MSG_INTERVAL_MS || '1000'),

  // Timing
  RAMP_UP_DURATION: __ENV.RAMP_UP_DURATION || '5m',
  STEADY_STATE_DURATION: __ENV.STEADY_STATE_DURATION || '10m',
  RAMP_DOWN_DURATION: __ENV.RAMP_DOWN_DURATION || '2m',

  // Token batch size for setup phase
  TOKEN_BATCH_SIZE: parseInt(__ENV.TOKEN_BATCH_SIZE || '50'),
};
