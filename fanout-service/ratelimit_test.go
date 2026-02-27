package main

import (
	"testing"
	"time"
)

func TestCircuitBreaker_New(t *testing.T) {
	cb := NewCircuitBreaker(5, 30)
	if cb == nil {
		t.Fatal("NewCircuitBreaker returned nil")
	}
	if cb.State() != CircuitBreakerClosed {
		t.Errorf("Expected initial state to be Closed, got %v", cb.State())
	}
}

func TestCircuitBreaker_Allow(t *testing.T) {
	cb := NewCircuitBreaker(3, 1)

	if !cb.Allow() {
		t.Error("Expected Allow() to return true when circuit breaker is closed")
	}
}

func TestCircuitBreaker_RecordFailure(t *testing.T) {
	cb := NewCircuitBreaker(3, 1)

	cb.RecordFailure()
	cb.RecordFailure()

	if cb.State() != CircuitBreakerClosed {
		t.Errorf("Expected state to remain Closed after 2 failures, got %v", cb.State())
	}

	cb.RecordFailure()

	if cb.State() != CircuitBreakerOpen {
		t.Errorf("Expected state to be Open after 3 failures, got %v", cb.State())
	}
}

func TestCircuitBreaker_OpenToHalfOpen(t *testing.T) {
	cb := NewCircuitBreaker(1, 1)

	cb.RecordFailure()

	if cb.State() != CircuitBreakerOpen {
		t.Fatalf("Expected state to be Open, got %v", cb.State())
	}

	time.Sleep(1100 * time.Millisecond)

	if !cb.Allow() {
		t.Error("Expected Allow() to return true after cooldown period (half-open)")
	}
}

func TestCircuitBreaker_HalfOpenToClosed(t *testing.T) {
	cb := NewCircuitBreaker(1, 1)

	cb.RecordFailure()
	time.Sleep(1100 * time.Millisecond)
	cb.Allow()

	cb.RecordSuccess()

	if cb.State() != CircuitBreakerClosed {
		t.Errorf("Expected state to be Closed after success, got %v", cb.State())
	}
}

func TestCircuitBreaker_HalfOpenToOpen(t *testing.T) {
	cb := NewCircuitBreaker(1, 1)

	cb.RecordFailure()
	time.Sleep(1100 * time.Millisecond)
	cb.Allow()

	cb.RecordFailure()

	if cb.State() != CircuitBreakerOpen {
		t.Errorf("Expected state to be Open after failure in half-open, got %v", cb.State())
	}
}

func TestCircuitBreaker_RecordSuccess(t *testing.T) {
	cb := NewCircuitBreaker(5, 30)

	cb.RecordFailure()
	cb.RecordFailure()
	cb.RecordSuccess()

	if cb.State() != CircuitBreakerClosed {
		t.Errorf("Expected state to be Closed after success, got %v", cb.State())
	}

	failures := cb.failures.Load()
	if failures != 0 {
		t.Errorf("Expected failures to be reset to 0, got %d", failures)
	}
}

func TestCircuitBreaker_Concurrency(t *testing.T) {
	cb := NewCircuitBreaker(100, 30)

	done := make(chan bool)

	for i := 0; i < 10; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				cb.Allow()
				cb.RecordFailure()
				cb.RecordSuccess()
			}
			done <- true
		}()
	}

	for i := 0; i < 10; i++ {
		<-done
	}
}

func TestCircuitBreaker_Threshold(t *testing.T) {
	tests := []struct {
		name      string
		threshold int
		failures  int
		wantOpen  bool
	}{
		{"threshold 1, 1 failure", 1, 1, true},
		{"threshold 5, 4 failures", 5, 4, false},
		{"threshold 5, 5 failures", 5, 5, true},
		{"threshold 10, 9 failures", 10, 9, false},
		{"threshold 10, 10 failures", 10, 10, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cb := NewCircuitBreaker(tt.threshold, 30)

			for i := 0; i < tt.failures; i++ {
				cb.RecordFailure()
			}

			isOpen := cb.State() == CircuitBreakerOpen
			if isOpen != tt.wantOpen {
				t.Errorf("Expected open=%v, got open=%v (state=%v)", tt.wantOpen, isOpen, cb.State())
			}
		})
	}
}

func TestCircuitBreaker_Cooldown(t *testing.T) {
	cb := NewCircuitBreaker(1, 2)

	cb.RecordFailure()

	if cb.Allow() {
		t.Error("Expected Allow() to return false when circuit breaker is open")
	}

	time.Sleep(2100 * time.Millisecond)

	if !cb.Allow() {
		t.Error("Expected Allow() to return true after cooldown period")
	}
}
