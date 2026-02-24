/**
 * Keycloak token helpers for k6 load tests.
 *
 * Uses Resource Owner Password Credentials (ROPC) grant to obtain
 * access tokens.  The nats-chat-app client has directAccessGrantsEnabled
 * so ROPC is allowed.
 */

import http from 'k6/http';
import { CONFIG } from './config.js';

/**
 * Get a Keycloak access token for a single user.
 * @returns {string} access_token (JWT)
 */
export function getToken(username, password) {
  const res = http.post(
    CONFIG.KEYCLOAK_TOKEN_URL,
    {
      grant_type: 'password',
      client_id: CONFIG.KEYCLOAK_CLIENT_ID,
      username: username,
      password: password,
    },
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      tags: { name: 'keycloak_token' },
    }
  );

  if (res.status !== 200) {
    console.error(
      'Token request failed for ' + username + ': ' + res.status + ' ' + res.body
    );
    return null;
  }

  return JSON.parse(res.body).access_token;
}

/**
 * Batch-fetch tokens for users loadtest-{start..end}.
 * Uses http.batch() for parallelism within each chunk.
 *
 * @param {number} start   First user index (1-based)
 * @param {number} end     Last user index (inclusive)
 * @param {number} [batchSize=50]  Parallel requests per batch
 * @returns {Array<{username: string, token: string}>}
 */
export function batchGetTokens(start, end, batchSize) {
  batchSize = batchSize || CONFIG.TOKEN_BATCH_SIZE;
  const results = [];

  for (let i = start; i <= end; i += batchSize) {
    const requests = [];
    for (let j = i; j < Math.min(i + batchSize, end + 1); j++) {
      const username = CONFIG.USER_PREFIX + String(j).padStart(4, '0');
      requests.push([
        'POST',
        CONFIG.KEYCLOAK_TOKEN_URL,
        {
          grant_type: 'password',
          client_id: CONFIG.KEYCLOAK_CLIENT_ID,
          username: username,
          password: CONFIG.USER_PASSWORD,
        },
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          tags: { name: 'keycloak_token_batch' },
        },
      ]);
    }

    const responses = http.batch(requests);
    for (let k = 0; k < responses.length; k++) {
      const idx = i + k;
      const username = CONFIG.USER_PREFIX + String(idx).padStart(4, '0');
      if (responses[k].status === 200) {
        results.push({
          username: username,
          token: JSON.parse(responses[k].body).access_token,
        });
      } else {
        console.warn('Token failed for ' + username + ': ' + responses[k].status);
      }
    }
  }

  return results;
}
