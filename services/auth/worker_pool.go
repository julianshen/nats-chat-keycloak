package main

import (
	"context"
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
	handler        func(msg *nats.Msg)
	queue          chan *nats.Msg
	requestTimeout time.Duration

	stopOnce sync.Once
	stopCh   chan struct{}
	wg       sync.WaitGroup

	inflight atomic.Int64

	rejections metric.Int64Counter
	timeouts   metric.Int64Counter
}

func NewAuthWorkerPool(
	handler func(msg *nats.Msg),
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
		queue:          make(chan *nats.Msg, queueSize),
		requestTimeout: requestTimeout,
		stopCh:         make(chan struct{}),
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

func (p *AuthWorkerPool) Submit(msg *nats.Msg) bool {
	select {
	case <-p.stopCh:
		p.rejections.Add(context.Background(), 1, metric.WithAttributes(attribute.String("reason", "stopped")))
		return false
	default:
	}

	select {
	case p.queue <- msg:
		return true
	default:
		p.rejections.Add(context.Background(), 1, metric.WithAttributes(attribute.String("reason", "queue_full")))
		return false
	}
}

func (p *AuthWorkerPool) Stop() {
	p.stopOnce.Do(func() {
		close(p.stopCh)
		close(p.queue)
		p.wg.Wait()
		slog.Info("Auth worker pool stopped")
	})
}

func (p *AuthWorkerPool) worker(id int) {
	defer p.wg.Done()

	for msg := range p.queue {
		start := time.Now()
		p.inflight.Add(1)

		p.handler(msg)

		elapsed := time.Since(start)
		p.inflight.Add(-1)
		if elapsed > p.requestTimeout {
			p.timeouts.Add(context.Background(), 1)
			slog.Warn("Auth request exceeded timeout threshold",
				"worker_id", id,
				"elapsed", elapsed.String(),
				"threshold", p.requestTimeout.String(),
			)
		}
	}
}
