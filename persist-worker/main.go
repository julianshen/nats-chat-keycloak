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
	_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
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
	stream, err := js.Stream(ctx, "CHAT_MESSAGES")
	if err != nil {
		log.Fatalf("Failed to get stream: %v", err)
	}

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
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		var chatMsg ChatMessage
		if err := json.Unmarshal(msg.Data(), &chatMsg); err != nil {
			log.Printf("WARN: Failed to unmarshal message: %v", err)
			msg.Ack()
			return
		}

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
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	log.Printf("Shutting down persist worker...")
}
