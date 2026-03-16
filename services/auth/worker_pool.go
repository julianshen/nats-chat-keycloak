package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// AuthWorkerPool provides bounded, concurrent processing for auth requests.
type AuthWorkerPool struct {
	handler func(ctx context.Context, msg *nats.Msg) error
	reject  func(msg *nats.Msg, reason string) error
	queue   chan *nats.Msg

	requestTimeout time.Duration

	mu       sync.Mutex
	stopOnce sync.Once
	wg       sync.WaitGroup
	stopped  atomic.Bool

	inflight atomic.Int64

	rejections metric.Int64Counter
	timeouts   metric.Int64Counter
}

func NewAuthWorkerPool(
	handler func(ctx context.Context, msg *nats.Msg) error,
	reject func(msg *nats.Msg, reason string) error,
	meter metric.Meter,
	workerCount int,
	queueSize int,
	requestTimeout time.Duration,
) (*AuthWorkerPool, error) {
	if workerCount <= 0 {
		return nil, fmt.Errorf("workerCount must be > 0")
	}
	if queueSize <= 0 {
		return nil, fmt.Errorf("queueSize must be > 0")
	}
	if requestTimeout <= 0 {
		return nil, fmt.Errorf("requestTimeout must be > 0")
	}

	rejections, _ := meter.Int64Counter("auth_rejections_total")
	timeouts, _ := meter.Int64Counter("auth_timeouts_total")
	queueDepth, _ := meter.Int64ObservableGauge("auth_queue_depth")
	inflightGauge, _ := meter.Int64ObservableGauge("auth_inflight")

	pool := &AuthWorkerPool{
		handler:        handler,
		reject:         reject,
		queue:          make(chan *nats.Msg, queueSize),
		requestTimeout: requestTimeout,
		rejections:     rejections,
		timeouts:       timeouts,
	}

	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(queueDepth, int64(len(pool.queue)))
		o.ObserveInt64(inflightGauge, pool.inflight.Load())
		return nil
	}, queueDepth, inflightGauge)

	for i := 0; i < workerCount; i++ {
		pool.wg.Add(1)
		go pool.worker(i + 1)
	}

	slog.Info("Auth worker pool started",
		"workers", workerCount,
		"queue_size", queueSize,
		"request_timeout", requestTimeout.String(),
	)

	return pool, nil
}

func (p *AuthWorkerPool) Submit(msg *nats.Msg) (bool, string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.stopped.Load() {
		p.rejections.Add(context.Background(), 1, metric.WithAttributes(attribute.String("reason", "stopped")))
		return false, "stopped"
	}

	select {
	case p.queue <- msg:
		return true, ""
	default:
		p.rejections.Add(context.Background(), 1, metric.WithAttributes(attribute.String("reason", "queue_full")))
		return false, "queue_full"
	}
}

func (p *AuthWorkerPool) Stop() {
	p.stopOnce.Do(func() {
		p.mu.Lock()
		p.stopped.Store(true)
		close(p.queue)
		p.mu.Unlock()
		p.wg.Wait()
		slog.Info("Auth worker pool stopped")
	})
}

func (p *AuthWorkerPool) worker(id int) {
	defer p.wg.Done()

	for msg := range p.queue {
		p.handleMessage(id, msg)
	}
}

func (p *AuthWorkerPool) handleMessage(id int, msg *nats.Msg) {
	ctx, cancel := context.WithTimeout(context.Background(), p.requestTimeout)
	defer cancel()

	start := time.Now()
	p.inflight.Add(1)
	err := p.handler(ctx, msg)
	elapsed := time.Since(start)
	p.inflight.Add(-1)

	if errors.Is(err, context.DeadlineExceeded) {
		p.timeouts.Add(context.Background(), 1)
		if rejectErr := p.reject(msg, "request timeout"); rejectErr != nil {
			slog.Error("Failed to send timeout auth rejection", "worker_id", id, "error", rejectErr)
		}
		slog.Warn("Auth request timed out",
			"worker_id", id,
			"elapsed", elapsed.String(),
			"threshold", p.requestTimeout.String(),
		)
		return
	}

	if err != nil {
		slog.Error("Auth request handler failed", "worker_id", id, "error", err)
		return
	}

	if elapsed > p.requestTimeout {
		p.timeouts.Add(context.Background(), 1)
		slog.Warn("Auth request exceeded timeout threshold",
			"worker_id", id,
			"elapsed", elapsed.String(),
			"threshold", p.requestTimeout.String(),
		)
	}
}
