#!/usr/bin/env bash
#
# Provision load-test users in Keycloak.
#
# Creates users loadtest-0001 .. loadtest-{N} in the nats-chat realm
# with the "user" role and password "loadtest123".
#
# Usage:
#   ./provision-users.sh              # default 10000 users
#   ./provision-users.sh 500          # create 500 users
#   KEYCLOAK_URL=http://kc:8080 ./provision-users.sh 1000
#
set -euo pipefail

NUM_USERS="${1:-10000}"
KC_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="nats-chat"
ADMIN_USER="${KC_ADMIN_USER:-admin}"
ADMIN_PASS="${KC_ADMIN_PASS:-admin}"
PASSWORD="loadtest123"
PREFIX="loadtest-"

echo "=== Provisioning ${NUM_USERS} load-test users in ${KC_URL}/realms/${REALM} ==="

# ── Get admin token ──────────────────────────────────────────────

TOKEN=$(curl -sf "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ADMIN_PASS}" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: Failed to get admin token. Is Keycloak running at ${KC_URL}?"
  exit 1
fi
echo "Admin token acquired"

# ── Get "user" role ID ───────────────────────────────────────────

ROLE_JSON=$(curl -sf "${KC_URL}/admin/realms/${REALM}/roles/user" \
  -H "Authorization: Bearer ${TOKEN}")
ROLE_ID=$(echo "$ROLE_JSON" | jq -r '.id')

if [ -z "$ROLE_ID" ] || [ "$ROLE_ID" = "null" ]; then
  echo "ERROR: Role 'user' not found in realm ${REALM}"
  exit 1
fi
echo "Role 'user' ID: ${ROLE_ID}"

# ── Create users ─────────────────────────────────────────────────

CREATED=0
SKIPPED=0

for i in $(seq 1 "$NUM_USERS"); do
  USERNAME="${PREFIX}$(printf '%04d' "$i")"

  # Refresh token every 200 users (admin tokens expire in 60s)
  if (( i % 200 == 0 )); then
    TOKEN=$(curl -sf "${KC_URL}/realms/master/protocol/openid-connect/token" \
      -d "grant_type=password" \
      -d "client_id=admin-cli" \
      -d "username=${ADMIN_USER}" \
      -d "password=${ADMIN_PASS}" | jq -r '.access_token')
  fi

  # Create user
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "${KC_URL}/admin/realms/${REALM}/users" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"${USERNAME}\",
      \"enabled\": true,
      \"credentials\": [{
        \"type\": \"password\",
        \"value\": \"${PASSWORD}\",
        \"temporary\": false
      }]
    }")

  if [ "$HTTP_CODE" = "201" ]; then
    # Get user ID and assign role
    USER_ID=$(curl -sf \
      "${KC_URL}/admin/realms/${REALM}/users?username=${USERNAME}&exact=true" \
      -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id')

    curl -sf \
      "${KC_URL}/admin/realms/${REALM}/users/${USER_ID}/role-mappings/realm" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "[${ROLE_JSON}]" > /dev/null

    CREATED=$((CREATED + 1))
  elif [ "$HTTP_CODE" = "409" ]; then
    SKIPPED=$((SKIPPED + 1))
  else
    echo "WARN: Unexpected status ${HTTP_CODE} for ${USERNAME}"
  fi

  # Progress
  if (( i % 500 == 0 )); then
    echo "  Progress: ${i}/${NUM_USERS} (created: ${CREATED}, skipped: ${SKIPPED})"
  fi
done

echo "=== Done: created ${CREATED}, skipped ${SKIPPED} (already exist) ==="
