package main

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
)

func TestAuthWorkerPoolProcessesMessages(t *testing.T) {
	var processed atomic.Int64
	doneCh := make(chan struct{}, 3)

	pool, err := NewAuthWorkerPool(func(_ *nats.Msg) {
		processed.Add(1)
		doneCh <- struct{}{}
	}, otel.Meter("test"), 2, 8, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}
	defer pool.Stop()

	for i := 0; i < 3; i++ {
		if ok := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
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

	pool, err := NewAuthWorkerPool(func(_ *nats.Msg) {
		<-block
	}, otel.Meter("test"), 1, 1, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}

	// First message occupies the only worker; second fills the queue.
	if ok := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
		t.Fatal("first Submit() should succeed")
	}
	if ok := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); !ok {
		t.Fatal("second Submit() should succeed")
	}
	if ok := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); ok {
		t.Fatal("third Submit() should be rejected when queue is full")
	}

	close(block)
	pool.Stop()
}

func TestAuthWorkerPoolRejectsAfterStop(t *testing.T) {
	pool, err := NewAuthWorkerPool(func(_ *nats.Msg) {}, otel.Meter("test"), 1, 1, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("NewAuthWorkerPool() error = %v", err)
	}
	pool.Stop()

	if ok := pool.Submit(&nats.Msg{Subject: "$SYS.REQ.USER.AUTH"}); ok {
		t.Fatal("Submit() should be rejected after Stop()")
	}
}
