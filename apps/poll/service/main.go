package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type createRequest struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
	User     string   `json:"user"`
}

type voteRequest struct {
	PollID    string `json:"pollId"`
	OptionIdx int    `json:"optionIdx"`
	User      string `json:"user"`
}

type closeRequest struct {
	PollID string `json:"pollId"`
	User   string `json:"user"`
}

type resultsRequest struct {
	PollID string `json:"pollId"`
	User   string `json:"user"`
}

type pollInfo struct {
	ID        string   `json:"id"`
	Room      string   `json:"room"`
	Question  string   `json:"question"`
	Options   []string `json:"options"`
	CreatedBy string   `json:"createdBy"`
	CreatedAt string   `json:"createdAt"`
	Closed    bool     `json:"closed"`
}

type voteCount struct {
	OptionIdx int `json:"optionIdx"`
	Count     int `json:"count"`
}

type pollResults struct {
	Poll       pollInfo    `json:"poll"`
	Votes      []voteCount `json:"votes"`
	UserVote   *int        `json:"userVote"`
	TotalVotes int         `json:"totalVotes"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx := context.Background()

	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("poll-service")
	reqCounter, _ := meter.Int64Counter("poll_requests_total",
		metric.WithDescription("Total poll requests"))
	reqDuration, _ := meter.Float64Histogram("poll_request_duration_seconds",
		metric.WithDescription("Duration of poll requests"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "poll-service")
	natsPass := envOrDefault("NATS_PASS", "poll-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	db, err := otelsql.Open("postgres", dbURL,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL))
	if err != nil {
		slog.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	otelsql.RegisterDBStatsMetrics(db, otelsql.WithAttributes(semconv.DBSystemPostgreSQL))

	for i := 0; i < 30; i++ {
		if err = db.Ping(); err == nil {
			break
		}
		slog.Info("Waiting for database", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Database not ready", "error", err)
		os.Exit(1)
	}

	slog.Info("Starting Poll Service", "nats_url", natsURL)

	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("poll-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
		)
		if err == nil {
			break
		}
		slog.Info("Waiting for NATS", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to NATS", "error", err)
		os.Exit(1)
	}
	defer nc.Close()
	slog.Info("Connected to NATS", "url", nc.ConnectedUrl())

	// Helper to publish updated event for fanout delivery
	publishUpdated := func(room, pollId string) {
		data, _ := json.Marshal(map[string]string{"pollId": pollId})
		nc.Publish(fmt.Sprintf("app.poll.%s.updated", room), data)
	}

	// Helper to get poll results
	getPollResults := func(ctx context.Context, pollId, user string) (*pollResults, error) {
		var p pollInfo
		var optionsJSON []byte
		var createdAt time.Time
		err := db.QueryRowContext(ctx,
			"SELECT id, room, question, options, created_by, created_at, closed FROM polls WHERE id = $1", pollId).
			Scan(&p.ID, &p.Room, &p.Question, &optionsJSON, &p.CreatedBy, &createdAt, &p.Closed)
		if err != nil {
			return nil, err
		}
		json.Unmarshal(optionsJSON, &p.Options)
		p.CreatedAt = createdAt.Format(time.RFC3339)

		rows, err := db.QueryContext(ctx,
			"SELECT option_idx, COUNT(*) FROM poll_votes WHERE poll_id = $1 GROUP BY option_idx ORDER BY option_idx", pollId)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		votes := make([]voteCount, len(p.Options))
		for i := range votes {
			votes[i].OptionIdx = i
		}
		total := 0
		for rows.Next() {
			var idx, count int
			rows.Scan(&idx, &count)
			if idx >= 0 && idx < len(votes) {
				votes[idx].Count = count
				total += count
			}
		}

		var userVote *int
		var uv int
		err = db.QueryRowContext(ctx,
			"SELECT option_idx FROM poll_votes WHERE poll_id = $1 AND user_id = $2", pollId, user).Scan(&uv)
		if err == nil {
			userVote = &uv
		}

		return &pollResults{Poll: p, Votes: votes, UserVote: userVote, TotalVotes: total}, nil
	}

	// Subscribe to app.poll.> with queue group
	_, err = nc.QueueSubscribe("app.poll.>", "poll-workers", func(msg *nats.Msg) {
		start := time.Now()

		// Parse subject: app.poll.{room}.{action}
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		room := parts[2]
		action := strings.Join(parts[3:], ".")

		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "poll."+action)
		defer span.End()
		span.SetAttributes(
			attribute.String("poll.room", room),
			attribute.String("poll.action", action),
		)

		switch action {
		case "create":
			var req createRequest
			if err := json.Unmarshal(msg.Data, &req); err != nil {
				msg.Respond([]byte(`{"error":"invalid request"}`))
				return
			}
			if req.Question == "" || len(req.Options) < 2 || req.User == "" {
				msg.Respond([]byte(`{"error":"question, at least 2 options, and user required"}`))
				return
			}

			pollId := uuid.New().String()[:8]
			optionsJSON, _ := json.Marshal(req.Options)

			_, err := db.ExecContext(ctx,
				"INSERT INTO polls (id, room, question, options, created_by) VALUES ($1, $2, $3, $4, $5)",
				pollId, room, req.Question, optionsJSON, req.User)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to create poll", "error", err)
				span.RecordError(err)
				msg.Respond([]byte(`{"error":"create failed"}`))
				return
			}

			msg.Respond([]byte(fmt.Sprintf(`{"pollId":"%s"}`, pollId)))
			publishUpdated(room, pollId)
			slog.InfoContext(ctx, "Poll created", "pollId", pollId, "room", room, "by", req.User)

		case "list":
			var req struct {
				User string `json:"user"`
			}
			json.Unmarshal(msg.Data, &req)

			rows, err := db.QueryContext(ctx,
				"SELECT id, room, question, options, created_by, created_at, closed FROM polls WHERE room = $1 ORDER BY created_at DESC", room)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to list polls", "error", err)
				msg.Respond([]byte("[]"))
				return
			}
			defer rows.Close()

			var polls []pollInfo
			for rows.Next() {
				var p pollInfo
				var optJSON []byte
				var cat time.Time
				if err := rows.Scan(&p.ID, &p.Room, &p.Question, &optJSON, &p.CreatedBy, &cat, &p.Closed); err != nil {
					continue
				}
				json.Unmarshal(optJSON, &p.Options)
				p.CreatedAt = cat.Format(time.RFC3339)
				polls = append(polls, p)
			}
			if polls == nil {
				polls = []pollInfo{}
			}
			data, _ := json.Marshal(polls)
			msg.Respond(data)

		case "vote":
			var req voteRequest
			if err := json.Unmarshal(msg.Data, &req); err != nil {
				msg.Respond([]byte(`{"error":"invalid request"}`))
				return
			}

			// Check poll exists and not closed
			var closed bool
			err := db.QueryRowContext(ctx, "SELECT closed FROM polls WHERE id = $1", req.PollID).Scan(&closed)
			if err != nil {
				msg.Respond([]byte(`{"error":"poll not found"}`))
				return
			}
			if closed {
				msg.Respond([]byte(`{"error":"poll is closed"}`))
				return
			}

			_, err = db.ExecContext(ctx,
				`INSERT INTO poll_votes (poll_id, user_id, option_idx) VALUES ($1, $2, $3)
				 ON CONFLICT (poll_id, user_id) DO UPDATE SET option_idx = $3, voted_at = NOW()`,
				req.PollID, req.User, req.OptionIdx)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to record vote", "error", err)
				msg.Respond([]byte(`{"error":"vote failed"}`))
				return
			}

			msg.Respond([]byte(`{"ok":true}`))
			publishUpdated(room, req.PollID)

		case "results":
			var req resultsRequest
			json.Unmarshal(msg.Data, &req)

			results, err := getPollResults(ctx, req.PollID, req.User)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to get results", "error", err)
				msg.Respond([]byte(`{"error":"not found"}`))
				return
			}
			data, _ := json.Marshal(results)
			msg.Respond(data)

		case "close":
			var req closeRequest
			if err := json.Unmarshal(msg.Data, &req); err != nil {
				msg.Respond([]byte(`{"error":"invalid request"}`))
				return
			}

			// Only creator can close
			var createdBy string
			err := db.QueryRowContext(ctx, "SELECT created_by FROM polls WHERE id = $1", req.PollID).Scan(&createdBy)
			if err != nil {
				msg.Respond([]byte(`{"error":"poll not found"}`))
				return
			}
			if createdBy != req.User {
				msg.Respond([]byte(`{"error":"only creator can close"}`))
				return
			}

			_, err = db.ExecContext(ctx, "UPDATE polls SET closed = TRUE WHERE id = $1", req.PollID)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to close poll", "error", err)
				msg.Respond([]byte(`{"error":"close failed"}`))
				return
			}

			msg.Respond([]byte(`{"ok":true}`))
			publishUpdated(room, req.PollID)
			slog.InfoContext(ctx, "Poll closed", "pollId", req.PollID, "room", room, "by", req.User)

		default:
			msg.Respond([]byte(`{"error":"unknown action"}`))
		}

		reqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", action)))
		reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", action)))
	})
	if err != nil {
		slog.Error("Failed to subscribe to app.poll.>", "error", err)
		os.Exit(1)
	}

	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	slog.Info("Poll Service ready — listening on app.poll.>")
	<-sigCtx.Done()
	slog.Info("Shutting down Poll Service")
	nc.Drain()
}
