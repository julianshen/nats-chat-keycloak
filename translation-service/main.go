package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/nats.go"
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
}

type ollamaRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

type ollamaStreamLine struct {
	Response string `json:"response"`
	Done     bool   `json:"done"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func callOllama(ctx context.Context, ollamaURL, text, targetLang string) (string, error) {
	lang, ok := langMap[targetLang]
	if !ok {
		return "", fmt.Errorf("unsupported language: %s", targetLang)
	}

	// translategemma prompt format: professional translator preamble + two blank lines before text
	prompt := fmt.Sprintf(
		"You are a professional translator to %s (%s). "+
			"You will translate the given text to %s, ensuring that the meaning and nuances of the original text are preserved. "+
			"Respect grammar, sentence structure, and cultural considerations while making the translation natural and fluent. "+
			"Only provide the translation without any explanations or additional text.\n\n\n%s",
		lang.Name, lang.Code, lang.Name, text)

	reqBody, _ := json.Marshal(ollamaRequest{
		Model:  "translategemma",
		Prompt: prompt,
		Stream: true,
	})

	httpReq, err := http.NewRequestWithContext(ctx, "POST", ollamaURL+"/api/generate", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("ollama request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama returned status %d", resp.StatusCode)
	}

	var result strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		var line ollamaStreamLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		result.WriteString(line.Response)
		if line.Done {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("reading stream: %w", err)
	}

	return strings.TrimSpace(result.String()), nil
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

		translated, err := callOllama(ctx, ollamaURL, req.Text, req.TargetLang)
		if err != nil {
			slog.ErrorContext(ctx, "Translation failed", "error", err, "user", req.User, "msgKey", req.MsgKey)
			span.RecordError(err)
			return
		}

		resp := translateResponse{
			TranslatedText: translated,
			TargetLang:     req.TargetLang,
			MsgKey:         req.MsgKey,
		}
		data, _ := json.Marshal(resp)

		deliverSubject := fmt.Sprintf("deliver.%s.translate.response", req.User)
		if err := nc.Publish(deliverSubject, data); err != nil {
			slog.ErrorContext(ctx, "Failed to publish translation result", "error", err, "subject", deliverSubject)
			span.RecordError(err)
			return
		}

		duration := time.Since(start).Seconds()
		translateCounter.Add(ctx, 1)
		translateDuration.Record(ctx, duration)
		span.SetAttributes(attribute.Int("translate.result_length", len(translated)))
		slog.InfoContext(ctx, "Translation completed",
			"target_lang", req.TargetLang,
			"user", req.User,
			"text_length", len(req.Text),
			"result_length", len(translated),
			"duration_ms", duration*1000,
		)
	})
	if err != nil {
		slog.Error("Failed to subscribe to translate.request", "error", err)
		os.Exit(1)
	}

	slog.Info("Translation service ready - listening on translate.request")

	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down translation service")
	nc.Drain()
}
