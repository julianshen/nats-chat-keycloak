package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/nats.go"
	"github.com/ollama/ollama/api"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

type langInfo struct {
	Name string
	Code string // ISO 639-1 or BCP 47
}

var langMap = map[string]langInfo{
	"en":    {Name: "English", Code: "en"},
	"ja":    {Name: "Japanese", Code: "ja"},
	"hi":    {Name: "Hindi", Code: "hi"},
	"pl":    {Name: "Polish", Code: "pl"},
	"de":    {Name: "German", Code: "de"},
	"zh-TW": {Name: "Traditional Chinese", Code: "zh-Hant"},
}

var healthy atomic.Bool

type translateRequest struct {
	Text       string `json:"text"`
	TargetLang string `json:"targetLang"`
	User       string `json:"user"`
	MsgKey     string `json:"msgKey"`
}

type translateResponse struct {
	TranslatedText string `json:"translatedText"`
	TargetLang     string `json:"targetLang"`
	MsgKey         string `json:"msgKey"`
	Done           bool   `json:"done"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

const batchInterval = 100 * time.Millisecond

func streamTranslation(ctx context.Context, client *api.Client, nc *nats.Conn, deliverSubject, targetLang, msgKey, text string) (int, error) {
	lang, ok := langMap[targetLang]
	if !ok {
		return 0, fmt.Errorf("unsupported language: %s", targetLang)
	}

	prompt := fmt.Sprintf(
		"You are a professional translator to %s (%s). "+
			"You will translate the given text to %s, ensuring that the meaning and nuances of the original text are preserved. "+
			"Respect grammar, sentence structure, and cultural considerations while making the translation natural and fluent. "+
			"Only provide the translation without any explanations or additional text.\n\n\n%s",
		lang.Name, lang.Code, lang.Name, text)

	var totalLen int
	var buf strings.Builder
	lastFlush := time.Now()

	flush := func(done bool) error {
		chunk := translateResponse{
			TranslatedText: buf.String(),
			TargetLang:     targetLang,
			MsgKey:         msgKey,
			Done:           done,
		}
		buf.Reset()
		lastFlush = time.Now()
		data, err := json.Marshal(chunk)
		if err != nil {
			return fmt.Errorf("marshal chunk: %w", err)
		}
		return nc.Publish(deliverSubject, data)
	}

	err := client.Generate(ctx, &api.GenerateRequest{
		Model:  "translategemma",
		Prompt: prompt,
	}, func(resp api.GenerateResponse) error {
		totalLen += len(resp.Response)
		buf.WriteString(resp.Response)

		if resp.Done {
			return flush(true)
		}
		if time.Since(lastFlush) >= batchInterval {
			return flush(false)
		}
		return nil
	})
	if err != nil {
		return totalLen, fmt.Errorf("ollama generate: %w", err)
	}

	return totalLen, nil
}

func main() {
	ctx := context.Background()

	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("translation-service")
	translateCounter, _ := meter.Int64Counter("translate_requests_total",
		metric.WithDescription("Total translation requests"))
	translateDuration, _ := meter.Float64Histogram("translate_duration_seconds",
		metric.WithDescription("Duration of translation requests"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "translation-service")
	natsPass := envOrDefault("NATS_PASS", "translation-service-secret")
	ollamaURL := envOrDefault("OLLAMA_URL", "http://localhost:11434")

	// Bridge OLLAMA_URL to OLLAMA_HOST for the SDK (backward compat)
	if os.Getenv("OLLAMA_HOST") == "" {
		os.Setenv("OLLAMA_HOST", ollamaURL)
	}
	ollamaClient, err := api.ClientFromEnvironment()
	if err != nil {
		slog.Error("Failed to create Ollama client", "error", err)
		os.Exit(1)
	}

	// Probe model availability at startup
	_, probeErr := ollamaClient.Show(ctx, &api.ShowRequest{Model: "translategemma"})
	if probeErr != nil {
		slog.Warn("translategemma model not available at startup", "error", probeErr)
		healthy.Store(false)
	} else {
		slog.Info("translategemma model verified")
		healthy.Store(true)
	}

	slog.Info("Starting Translation Service", "nats_url", natsURL, "ollama_url", ollamaURL)

	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("translation-service"),
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

	_, err = nc.QueueSubscribe("translate.request", "translate-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "translate")
		defer span.End()

		var req translateRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			slog.ErrorContext(ctx, "Failed to parse request", "error", err)
			span.RecordError(err)
			return
		}

		span.SetAttributes(
			attribute.String("translate.target_lang", req.TargetLang),
			attribute.String("translate.user", req.User),
			attribute.String("translate.msg_key", req.MsgKey),
			attribute.Int("translate.text_length", len(req.Text)),
		)

		if req.Text == "" || req.TargetLang == "" || req.User == "" || req.MsgKey == "" {
			slog.ErrorContext(ctx, "Missing required fields", "text_empty", req.Text == "", "targetLang_empty", req.TargetLang == "", "user_empty", req.User == "", "msgKey_empty", req.MsgKey == "")
			return
		}

		deliverSubject := fmt.Sprintf("deliver.%s.translate.response", req.User)
		resultLen, err := streamTranslation(ctx, ollamaClient, nc, deliverSubject, req.TargetLang, req.MsgKey, req.Text)
		if err != nil {
			slog.ErrorContext(ctx, "Translation failed", "error", err, "user", req.User, "msgKey", req.MsgKey)
			span.RecordError(err)
			healthy.Store(false)
			return
		}
		healthy.Store(true)

		duration := time.Since(start).Seconds()
		translateCounter.Add(ctx, 1)
		translateDuration.Record(ctx, duration)
		span.SetAttributes(attribute.Int("translate.result_length", resultLen))
		slog.InfoContext(ctx, "Translation completed",
			"target_lang", req.TargetLang,
			"user", req.User,
			"text_length", len(req.Text),
			"result_length", resultLen,
			"duration_ms", duration*1000,
		)
	})
	if err != nil {
		slog.Error("Failed to subscribe to translate.request", "error", err)
		os.Exit(1)
	}

	// Respond to translate.ping with health status (no queue group — lightweight, avoids blocking behind busy translate workers)
	_, err = nc.Subscribe("translate.ping", func(msg *nats.Msg) {
		data, _ := json.Marshal(struct {
			Available bool `json:"available"`
		}{healthy.Load()})
		msg.Respond(data)
	})
	if err != nil {
		slog.Error("Failed to subscribe to translate.ping", "error", err)
		os.Exit(1)
	}

	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Background health re-probe: check Ollama model every 30s
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sigCtx.Done():
				return
			case <-ticker.C:
				_, err := ollamaClient.Show(sigCtx, &api.ShowRequest{Model: "translategemma"})
				if err != nil {
					if healthy.Load() {
						slog.Warn("Ollama health check failed", "error", err)
					}
					healthy.Store(false)
				} else {
					if !healthy.Load() {
						slog.Info("Ollama health check recovered")
					}
					healthy.Store(true)
				}
			}
		}
	}()

	slog.Info("Translation service ready - listening on translate.request and translate.ping")

	<-sigCtx.Done()

	slog.Info("Shutting down translation service")
	nc.Drain()
}
