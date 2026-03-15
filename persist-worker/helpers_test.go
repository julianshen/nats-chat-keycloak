package main

import "testing"

func TestNullableString(t *testing.T) {
	if nullableString("") != nil {
		t.Error("expected nil for empty string")
	}
	if nullableString("hello") != "hello" {
		t.Error("expected 'hello' for non-empty string")
	}
}

func TestNullableInt64(t *testing.T) {
	if nullableInt64(0) != nil {
		t.Error("expected nil for zero")
	}
	got := nullableInt64(42)
	if got != int64(42) {
		t.Errorf("expected 42, got %v", got)
	}
}

func TestNullableE2EEEpoch(t *testing.T) {
	if nullableE2EEEpoch(nil) != nil {
		t.Error("expected nil for nil E2EEInfo")
	}
	got := nullableE2EEEpoch(&E2EEInfo{Epoch: 3})
	if got != 3 {
		t.Errorf("expected 3, got %v", got)
	}
}
