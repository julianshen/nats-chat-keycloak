# Message Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist chat messages via JetStream + PostgreSQL and serve history via NATS request/reply.

**Architecture:** JetStream captures messages as a WAL on `chat.*` and `admin.*` subjects. A persist-worker Go service consumes from JetStream and writes to PostgreSQL. A history-service Go service handles NATS request/reply on `chat.history.*` to query PostgreSQL and return message history. The web client requests history when entering a room.

**Tech Stack:** Go 1.22, NATS JetStream, PostgreSQL 16, React/TypeScript (nats.ws), Docker Compose

**Important design note:** The JetStream stream uses `chat.*` (single wildcard) NOT `chat.>` to avoid capturing `chat.history.*` request/reply traffic. History requests use `chat.history.{room}` which is two tokens deep and won't match `chat.*`.

---

### Task 1: NATS Configuration — Enable JetStream and Add Service Users

**Files:**
- Modify: `nats/nats-server.conf`

**Step 1: Add JetStream config and service users**

Add JetStream block and two new users to `nats-server.conf`. The persist-worker and history-service users go in the CHAT account so they have access to chat subjects. Add their names to `auth_users` so they bypass auth callout.

```conf
server_name: nats-chat-server

jetstream {
  store_dir: /data/jetstream
  max_mem: 64M
  max_file: 256M
}

accounts {
  AUTH {
    users: [
      { user: auth, password: auth-secret-password }
    ]
  }
  CHAT {
    jetstream: enabled
    users: [
      { user: persist-worker, password: persist-worker-secret }
      { user: history-service, password: history-service-secret }
    ]
  }
  SYS {}
}

system_account: SYS

authorization {
  auth_callout {
    issuer: ABJHLOVMPA4CI6R5KLNGOB4GSLNIY7IOUPAJC4YFNDLQVIOBYQGUWVLA
    auth_users: [ auth, persist-worker, history-service ]
    account: AUTH
    xkey: XAB3NANV3M6N7AHSQP2U5FRWKKUT7EG2ZXXABV4XVXYQRJGM4S2CZGHT
  }
}

websocket {
  port: 9222
  no_tls: true
}

debug: false
trace: false
logtime: true
```

**Step 2: Add JetStream data volume to docker-compose.yml nats service**

Add a volume for JetStream persistence:

```yaml
  nats:
    image: nats:2.10
    command: -c /etc/nats/nats-server.conf -DV
    ports:
      - "4222:4222"
      - "9222:9222"
      - "8222:8222"
    volumes:
      - ./nats/nats-server.conf:/etc/nats/nats-server.conf:ro
      - nats-data:/data/jetstream
```

Add at the bottom of docker-compose.yml:
```yaml
volumes:
  nats-data:
  postgres-data:
```

**Step 3: Verify NATS restarts with JetStream**

Run: `docker compose up -d --build nats && sleep 3 && docker compose logs nats --tail 10`
Expected: Logs show "JetStream" enabled message, no errors.

**Step 4: Commit**

```bash
git add nats/nats-server.conf docker-compose.yml
git commit -m "feat: enable JetStream and add persist-worker/history-service users"
```

---

### Task 2: PostgreSQL — Add Docker Service with Schema Init

**Files:**
- Create: `postgres/init.sql`
- Modify: `docker-compose.yml`

**Step 1: Create PostgreSQL init script**

Create `postgres/init.sql`:

```sql
CREATE TABLE IF NOT EXISTS messages (
    id          BIGSERIAL PRIMARY KEY,
    room        VARCHAR(255) NOT NULL,
    username    VARCHAR(255) NOT NULL,
    text        TEXT NOT NULL,
    timestamp   BIGINT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room, timestamp DESC);
```

**Step 2: Add postgres service to docker-compose.yml**

Add after the `nats` service:

```yaml
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: chatdb
      POSTGRES_USER: chat
      POSTGRES_PASSWORD: chat-secret
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chat -d chatdb"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
```

**Step 3: Verify PostgreSQL starts and schema is created**

Run: `docker compose up -d postgres && sleep 5 && docker compose exec postgres psql -U chat -d chatdb -c '\dt'`
Expected: Shows `messages` table.

**Step 4: Commit**

```bash
git add postgres/init.sql docker-compose.yml
git commit -m "feat: add PostgreSQL service with messages schema"
```

---

### Task 3: Persist Worker — Go Service

**Files:**
- Create: `persist-worker/main.go`
- Create: `persist-worker/go.mod`
- Create: `persist-worker/Dockerfile`

**Step 1: Create go.mod**

Create `persist-worker/go.mod`:

```
module github.com/example/nats-chat-persist-worker

go 1.22

require (
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
)
```

Run: `cd persist-worker && go mod tidy`

**Step 2: Create main.go**

Create `persist-worker/main.go`:

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

type ChatMessage struct {
	User      string `json:"user"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
	Room      string `json:"room"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "persist-worker")
	natsPass := envOrDefault("NATS_PASS", "persist-worker-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	log.Printf("Starting Persist Worker")
	log.Printf("  NATS URL: %s", natsURL)

	// Connect to PostgreSQL with retry
	var db *sql.DB
	var err error
	for attempt := 1; attempt <= 30; attempt++ {
		db, err = sql.Open("postgres", dbURL)
		if err == nil {
			err = db.Ping()
		}
		if err == nil {
			break
		}
		log.Printf("Attempt %d: waiting for PostgreSQL... (%v)", attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to PostgreSQL: %v", err)
	}
	defer db.Close()
	log.Printf("Connected to PostgreSQL")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("persist-worker"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
		)
		if err == nil {
			break
		}
		log.Printf("Attempt %d: waiting for NATS... (%v)", attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to NATS: %v", err)
	}
	defer nc.Close()
	log.Printf("Connected to NATS at %s", nc.ConnectedUrl())

	// Create JetStream context
	js, err := jetstream.New(nc)
	if err != nil {
		log.Fatalf("Failed to create JetStream context: %v", err)
	}

	// Ensure stream exists
	ctx := context.Background()
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:      "CHAT_MESSAGES",
		Subjects:  []string{"chat.*", "admin.*"},
		Retention: jetstream.LimitsPolicy,
		MaxMsgs:   10000,
		MaxAge:    7 * 24 * time.Hour,
		Storage:   jetstream.FileStorage,
	})
	if err != nil {
		log.Fatalf("Failed to create/update stream: %v", err)
	}
	log.Printf("JetStream stream CHAT_MESSAGES ready (subjects: chat.*, admin.*)")

	// Create durable consumer
	cons, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       "persist-worker",
		AckPolicy:     jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
	})
	if err != nil {
		log.Fatalf("Failed to create consumer: %v", err)
	}
	log.Printf("JetStream consumer 'persist-worker' ready")

	// Prepare insert statement
	insertStmt, err := db.Prepare(
		"INSERT INTO messages (room, username, text, timestamp) VALUES ($1, $2, $3, $4)",
	)
	if err != nil {
		log.Fatalf("Failed to prepare insert statement: %v", err)
	}
	defer insertStmt.Close()

	// Consume messages
	consumeCtx, consumeCancel := context.WithCancel(ctx)
	defer consumeCancel()

	cc, err := cons.Consume(func(msg jetstream.Msg) {
		var chatMsg ChatMessage
		if err := json.Unmarshal(msg.Data(), &chatMsg); err != nil {
			log.Printf("WARN: Failed to unmarshal message: %v", err)
			msg.Ack()
			return
		}

		// Derive room from subject if not in message
		if chatMsg.Room == "" {
			chatMsg.Room = msg.Subject()
		}

		_, err := insertStmt.Exec(chatMsg.Room, chatMsg.User, chatMsg.Text, chatMsg.Timestamp)
		if err != nil {
			log.Printf("ERROR: Failed to insert message: %v — will retry via nack", err)
			msg.Nak()
			return
		}

		msg.Ack()
	})
	if err != nil {
		log.Fatalf("Failed to start consumer: %v", err)
	}
	defer cc.Stop()

	log.Printf("Consuming messages from CHAT_MESSAGES stream...")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(consumeCtx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	log.Printf("Shutting down persist worker...")
}
```

**Step 3: Create Dockerfile**

Create `persist-worker/Dockerfile`:

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /persist-worker .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /persist-worker /persist-worker

ENTRYPOINT ["/persist-worker"]
```

**Step 4: Run go mod tidy to generate go.sum**

Run: `cd persist-worker && go mod tidy`

**Step 5: Add persist-worker service to docker-compose.yml**

Add after postgres service:

```yaml
  persist-worker:
    build: ./persist-worker
    environment:
      NATS_URL: nats://nats:4222
      NATS_USER: persist-worker
      NATS_PASS: persist-worker-secret
      DATABASE_URL: postgres://chat:chat-secret@postgres:5432/chatdb?sslmode=disable
    depends_on:
      - nats
      - postgres
    restart: unless-stopped
```

**Step 6: Build and verify**

Run: `docker compose up -d --build persist-worker && sleep 8 && docker compose logs persist-worker --tail 10`
Expected: Logs show "Connected to PostgreSQL", "Connected to NATS", "JetStream stream CHAT_MESSAGES ready", "Consuming messages".

**Step 7: Commit**

```bash
git add persist-worker/ docker-compose.yml
git commit -m "feat: add persist-worker service (JetStream consumer -> PostgreSQL)"
```

---

### Task 4: History Service — Go Service

**Files:**
- Create: `history-service/main.go`
- Create: `history-service/go.mod`
- Create: `history-service/Dockerfile`

**Step 1: Create go.mod**

Create `history-service/go.mod`:

```
module github.com/example/nats-chat-history-service

go 1.22

require (
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
)
```

Run: `cd history-service && go mod tidy`

**Step 2: Create main.go**

Create `history-service/main.go`:

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
)

type ChatMessage struct {
	User      string `json:"user"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
	Room      string `json:"room"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "history-service")
	natsPass := envOrDefault("NATS_PASS", "history-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	log.Printf("Starting History Service")

	// Connect to PostgreSQL with retry
	var db *sql.DB
	var err error
	for attempt := 1; attempt <= 30; attempt++ {
		db, err = sql.Open("postgres", dbURL)
		if err == nil {
			err = db.Ping()
		}
		if err == nil {
			break
		}
		log.Printf("Attempt %d: waiting for PostgreSQL... (%v)", attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to PostgreSQL: %v", err)
	}
	defer db.Close()
	log.Printf("Connected to PostgreSQL")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("history-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
		)
		if err == nil {
			break
		}
		log.Printf("Attempt %d: waiting for NATS... (%v)", attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to NATS: %v", err)
	}
	defer nc.Close()
	log.Printf("Connected to NATS at %s", nc.ConnectedUrl())

	// Prepare query statement
	queryStmt, err := db.Prepare(
		"SELECT room, username, text, timestamp FROM messages WHERE room = $1 ORDER BY timestamp DESC LIMIT 50",
	)
	if err != nil {
		log.Fatalf("Failed to prepare query: %v", err)
	}
	defer queryStmt.Close()

	// Subscribe to history requests: chat.history.<room>
	_, err = nc.Subscribe("chat.history.*", func(msg *nats.Msg) {
		// Extract room from subject: chat.history.general -> general
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]

		// The room field stored in DB is "chat.{room}" (the NATS subject)
		// but the ChatMessage.room field stores the room name (e.g., "general")
		// Query by room name first, fall back to subject
		rows, err := queryStmt.Query(room)
		if err != nil {
			log.Printf("ERROR: Query failed for room %s: %v", room, err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var messages []ChatMessage
		for rows.Next() {
			var m ChatMessage
			if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp); err != nil {
				log.Printf("WARN: Failed to scan row: %v", err)
				continue
			}
			messages = append(messages, m)
		}

		// Reverse to chronological order (query was DESC)
		for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
			messages[i], messages[j] = messages[j], messages[i]
		}

		if messages == nil {
			messages = []ChatMessage{}
		}

		data, err := json.Marshal(messages)
		if err != nil {
			log.Printf("ERROR: Failed to marshal history: %v", err)
			msg.Respond([]byte("[]"))
			return
		}

		msg.Respond(data)
		log.Printf("Served %d messages for room %s", len(messages), room)
	})
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}
	log.Printf("Subscribed to chat.history.* — ready to serve history requests")

	// Wait for shutdown
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	log.Printf("Shutting down history service...")
	nc.Drain()
}
```

**Step 3: Create Dockerfile**

Create `history-service/Dockerfile` (identical pattern to persist-worker):

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /history-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /history-service /history-service

ENTRYPOINT ["/history-service"]
```

**Step 4: Run go mod tidy**

Run: `cd history-service && go mod tidy`

**Step 5: Add history-service to docker-compose.yml**

Add after persist-worker:

```yaml
  history-service:
    build: ./history-service
    environment:
      NATS_URL: nats://nats:4222
      NATS_USER: history-service
      NATS_PASS: history-service-secret
      DATABASE_URL: postgres://chat:chat-secret@postgres:5432/chatdb?sslmode=disable
    depends_on:
      - nats
      - postgres
    restart: unless-stopped
```

**Step 6: Build and verify**

Run: `docker compose up -d --build history-service && sleep 8 && docker compose logs history-service --tail 10`
Expected: Logs show "Connected to PostgreSQL", "Connected to NATS", "Subscribed to chat.history.*".

**Step 7: Commit**

```bash
git add history-service/ docker-compose.yml
git commit -m "feat: add history-service (NATS request/reply -> PostgreSQL query)"
```

---

### Task 5: Update Auth Callout Permissions

**Files:**
- Modify: `auth-service/permissions.go`

The history service subscribes to `chat.history.*` in the CHAT account. Browser users need to publish to `chat.history.{room}` to make requests. Currently users can pub on `chat.>` which matches `chat.history.*`, so **publish permission is already covered**.

However, users also need to be able to receive the reply. NATS request/reply uses `_INBOX.>` subjects. Users already have sub on `_INBOX.>`, so this is also covered.

**No permission changes needed.** The existing `chat.>` pub and `_INBOX.>` sub already allow history requests.

Skip to commit:

```bash
git commit --allow-empty -m "chore: verified auth permissions cover chat.history.* requests"
```

---

### Task 6: Web Client — Fetch History on Room Enter

**Files:**
- Modify: `web/src/components/ChatRoom.tsx`

**Step 1: Add history fetch when entering a room**

In `ChatRoom.tsx`, after subscribing to live messages, send a NATS request to `chat.history.{room}` and prepend the results. The key change is in the `useEffect` that handles room subscription.

Replace the subscription useEffect with one that:
1. Fetches history via `nc.request('chat.history.{room}')`
2. Sets history messages as initial state
3. Then subscribes to live messages and appends them

```tsx
  // Subscribe to the room subject and fetch history
  useEffect(() => {
    if (!nc || !connected) return;

    setMessages([]); // Clear messages when switching rooms
    setPubError(null);

    // Fetch history first
    const roomName = room === '__admin__' ? '__admin__' : room;
    const historySubject = `chat.history.${roomName}`;

    nc.request(historySubject, sc.encode(''), { timeout: 5000 })
      .then((reply) => {
        try {
          const history = JSON.parse(sc.decode(reply.data)) as ChatMessage[];
          if (history.length > 0) {
            setMessages(history);
          }
        } catch {
          console.log('[NATS] Failed to parse history response');
        }
      })
      .catch((err) => {
        console.log('[NATS] History request failed (service may not be running):', err);
      });

    // Subscribe to live messages
    const sub = nc.subscribe(subject);
    subRef.current = sub;

    (async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as ChatMessage;
            setMessages((prev) => [...prev.slice(-200), data]);
          } catch {
            // Ignore malformed messages
          }
        }
      } catch (err) {
        console.log(`[NATS] Subscription ended for ${subject}:`, err);
      }
    })();

    return () => {
      sub.unsubscribe();
      subRef.current = null;
    };
  }, [nc, connected, subject, sc, room]);
```

**Step 2: Verify by opening browser**

Open http://localhost:3000, log in, send some messages. Refresh the page. Messages should persist and appear as history when re-entering the room.

**Step 3: Commit**

```bash
git add web/src/components/ChatRoom.tsx
git commit -m "feat: fetch message history from history-service on room enter"
```

---

### Task 7: Full Integration — Docker Compose Up and Smoke Test

**Step 1: Bring everything up**

Run: `docker compose down && docker compose up -d --build`

**Step 2: Verify all services are running**

Run: `docker compose ps`
Expected: 7 services all "Up": keycloak, nats, auth-service, postgres, persist-worker, history-service, web.

**Step 3: Smoke test**

1. Open http://localhost:3000
2. Log in as alice/alice123
3. Send several messages in #general
4. Check persist-worker logs: `docker compose logs persist-worker --tail 5`
   Expected: Messages being inserted
5. Check PostgreSQL: `docker compose exec postgres psql -U chat -d chatdb -c 'SELECT count(*) FROM messages'`
   Expected: Count matches messages sent
6. Refresh browser page — messages should appear as history
7. Log in as bob/bob123 in another browser/incognito — should see alice's history

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete message persistence (JetStream + PostgreSQL + history service)"
```
