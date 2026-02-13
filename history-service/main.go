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
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]

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
