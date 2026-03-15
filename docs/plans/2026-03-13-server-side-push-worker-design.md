# Server-side Mobile Push Worker Design (APNS/FCM)

## Goal
Build a backend worker that converts existing in-app NATS notifications into platform push notifications (APNS/FCM) for offline or backgrounded mobile users, without changing chat publish subjects.

## Non-goals
- No direct APNS/FCM publishing from web/mobile clients.
- No "subscribe all rooms" client pattern.
- No message-content duplication in notification subjects.

## Existing messaging model to reuse
- Room notifications: `room.notify.{room}` (metadata + `notifyId`, no text body)
- DM notifications: `deliver.{userId}.notify.{room}`
- Content fetch API: `msg.get` (request/reply using `{ notifyId, room }`)

The push worker should consume the same notification streams used by interactive clients and only fetch full content when required for push rendering.

## High-level architecture
```text
chat.{room} -> fanout-service -> room.notify.{room} / deliver.{userId}.notify.{room}
                                      |
                                      v
                               push-worker (new)
                                      |
                  +-------------------+-------------------+
                  |                                       |
         APNS provider client                    FCM provider client
```

## New service: `push-worker`
Single responsibility: translate NATS notify events into APNS/FCM sends for eligible users.

### Core responsibilities
1. Consume notification events.
2. Resolve target recipients (room members or DM participants).
3. Apply delivery policy (offline/backgrounded, mute, quiet hours, throttling).
4. Optionally fetch message content via `msg.get` for payload text.
5. Send push via APNS/FCM.
6. Emit delivery telemetry + retry failures.

## Subject strategy (important)
Do **not** introduce APNS/FCM-specific chat subjects for normal message flow.

Recommended subscriptions for push-worker:
- `room.notify.*` (room + private-room metadata stream)
- `deliver.*.notify.*` (DM metadata stream)

Why:
- Keeps single source of truth for event generation in fanout-service.
- Avoids double-publish and routing drift.
- Preserves capability model (`notifyId` + `msg.get`) for content retrieval.

## Recipient resolution
Since `room.notify.{room}` is multicast and not per-user, push-worker must map room -> members.

Use one of:
1. Request/reply to room-service (`room.members.{room}`), with short TTL cache.
2. Local membership cache updated by subscribing to `room.changed.*`.

Recommended: hybrid
- Primary: local cache for latency.
- Fallback: request `room.members.{room}` on cache miss/staleness.

For `deliver.{userId}.notify.{room}` subjects, `userId` is already a direct target.

## Device registry model
Add/extend a persistent registry table (Postgres):

- `user_id` (indexed)
- `platform` (`ios` | `android`)
- `push_token` (unique)
- `bundle_id` / `project_id`
- `app_env` (`dev` | `prod`)
- `last_seen_at`
- `is_enabled`
- `is_background_allowed`
- `room_mute_overrides` (JSONB)

Expose NATS endpoints (not HTTP required):
- `push.device.register`
- `push.device.unregister`
- `push.device.list.{userId}` (admin/support only)

## Push eligibility policy
Push only when all are true:
1. User has at least one valid enabled device token.
2. Sender is not the recipient.
3. Recipient currently offline or app backgrounded (presence signal).
4. Room/DM notifications not muted.
5. Event is push-worthy (`message`, optionally `mention`, thread rules configurable).

## Content policy
Notification event only has metadata. To include preview text:
1. Fetch full message via `msg.get` with `{ notifyId, room }`.
2. Apply redaction rules:
   - Hidden preview mode -> generic "New message".
   - E2EE mode -> never include plaintext preview.
3. Truncate and sanitize output before APNS/FCM send.

If `msg.get` fails, send fallback generic push rather than dropping notification.

## Delivery reliability
Use at-least-once processing with idempotency key:
- key: `{notifyId}:{targetUser}:{deviceToken}`
- store in Redis/NATS KV/Postgres with short TTL (24-72h)

Retry strategy:
- transient errors: exponential backoff (e.g., 1s, 5s, 30s, 2m)
- permanent token errors: disable token and emit cleanup event

## Security and permissions
NATS permissions for push-worker:
- sub: `room.notify.*`, `deliver.*.notify.*`, `room.changed.*` (if using cache updates)
- req: `msg.get`, `room.members.*` (if using request fallback)
- pub: `push.metrics.*` (optional)

Do not grant publish on `chat.>`.

## Observability
Metrics:
- `push_received_total{type=room|dm}`
- `push_eligible_total`
- `push_sent_total{provider=apns|fcm}`
- `push_failed_total{reason}`
- `push_retry_total`
- `push_dedup_dropped_total`
- `push_msg_get_fail_total`

Tracing spans:
- `push.consume`
- `push.resolve_recipients`
- `push.fetch_content`
- `push.send.apns` / `push.send.fcm`

## Rollout plan
1. Phase 1: DM-only push (`deliver.*.notify.*`) with generic text.
2. Phase 2: Room push via `room.notify.*` + membership cache.
3. Phase 3: Add content preview via `msg.get` with privacy controls.
4. Phase 4: Add advanced policies (mentions-only, quiet hours, digesting).

## Why this design answers the channel question
- APNS/FCM does **not** require a special chat subject.
- Keep existing notify subjects and implement push fanout server-side.
- Mobile clients should subscribe only while foregrounded to joined rooms (plus deliver user stream), not all rooms.
