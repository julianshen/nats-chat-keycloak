package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
)

func TestAuthWorkerPoolProcessesMessages(t *testing.T) {
	var processed atomic.Int64
	doneCh := make(chan struct{}, 3)

	pool, err := NewAuthWorkerPool(func(_ context.Context, _ *nats.Msg) error {
		processed.Add(1)
		doneCh <- struct{}{}
		return nil
	}, func(_ *nats.Msg, _ string) error {
		return nil
	}, otel.Meter("test"), 2, 8, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}
	defer pool.Stop()

	for i := 0; i < 3; i++ {
		if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
			t.Fatalf("Submit() returned false at index %d", i)
		}
	}

	timeout := time.After(2 * time.Second)
	received := 0
	for received < 3 {
		select {
		case <-doneCh:
			received++
		case <-timeout:
			t.Fatalf("timed out waiting for messages to process; processed=%d", processed.Load())
		}
	}
}

func TestAuthWorkerPoolRejectsWhenQueueFull(t *testing.T) {
	block := make(chan struct{})
	started := make(chan struct{}, 1)

	pool, err := NewAuthWorkerPool(func(_ context.Context, _ *nats.Msg) error {
		select {
		case started <- struct{}{}:
		default:
		}
		<-block
		return nil
	}, func(_ *nats.Msg, _ string) error {
		return nil
	}, otel.Meter("test"), 1, 1, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}

	// First message occupies the only worker; second fills the queue.
	if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
		t.Fatal("first Submit() should succeed")
	}
	<-started
	if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
		t.Fatal("second Submit() should succeed")
	}
	if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); ok {
		t.Fatal("third Submit() should be rejected when queue is full")
	}

	close(block)
	pool.Stop()
}

func TestAuthWorkerPoolRejectsAfterStop(t *testing.T) {
	pool, err := NewAuthWorkerPool(func(_ context.Context, _ *nats.Msg) error { return nil }, func(_ *nats.Msg, _ string) error {
		return nil
	}, otel.Meter("test"), 1, 1, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}
	pool.Stop()

	if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); ok {
		t.Fatal("Submit() should be rejected after Stop()")
	}
}

func TestAuthWorkerPoolStopDrainsBufferedMessages(t *testing.T) {
	block := make(chan struct{})
	started := make(chan struct{}, 2)
	done := make(chan struct{}, 2)
	var entered atomic.Int64

	pool, err := NewAuthWorkerPool(func(_ context.Context, _ *nats.Msg) error {
		entered.Add(1)
		started <- struct{}{}
		<-block
		done <- struct{}{}
		return nil
	}, func(_ *nats.Msg, _ string) error {
		return nil
	}, otel.Meter("test"), 1, 2, 2*time.Second)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}

	if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
		t.Fatal("first Submit() should succeed")
	}
	if ok, _ := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
		t.Fatal("second Submit() should succeed")
	}

	<-started // first message is in-flight, second is buffered

	var stopWG sync.WaitGroup
	stopWG.Add(1)
	go func() {
		defer stopWG.Done()
		pool.Stop()
	}()

	close(block)

	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for message %d to complete", i+1)
		}
	}

	stopCh := make(chan struct{})
	go func() {
		stopWG.Wait()
		close(stopCh)
	}()

	select {
	case <-stopCh:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() did not return after draining buffered messages")
	}

	if got := entered.Load(); got != 2 {
		t.Fatalf("expected 2 handled messages, got %d", got)
	}
}
