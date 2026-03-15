package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSingleflight_Dedup(t *testing.T) {
	sf := newSingleflight()
	var callCount atomic.Int32
	expected := []string{"alice", "bob"}

	// Two-phase barrier: all goroutines signal "arrived", then wait for release
	var arrived sync.WaitGroup
	ready := make(chan struct{})
	var wg sync.WaitGroup
	results := make([][]string, 10)

	arrived.Add(10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			arrived.Done() // signal arrival
			<-ready        // wait for release
			results[idx] = sf.do("room1", func() []string {
				callCount.Add(1)
				time.Sleep(50 * time.Millisecond) // hold the lock so others coalesce
				return expected
			})
		}(i)
	}
	arrived.Wait() // all goroutines are at the barrier
	close(ready)   // release all at once
	wg.Wait()

	if count := callCount.Load(); count != 1 {
		t.Errorf("expected fn to be called once, got %d", count)
	}
	for i, r := range results {
		if len(r) != 2 || r[0] != "alice" || r[1] != "bob" {
			t.Errorf("goroutine %d got unexpected result: %v", i, r)
		}
	}
}

func TestSingleflight_IndependentKeys(t *testing.T) {
	sf := newSingleflight()
	var count1, count2 atomic.Int32

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		sf.do("key1", func() []string {
			count1.Add(1)
			return []string{"a"}
		})
	}()

	go func() {
		defer wg.Done()
		sf.do("key2", func() []string {
			count2.Add(1)
			return []string{"b"}
		})
	}()

	wg.Wait()

	if count1.Load() != 1 {
		t.Errorf("key1 fn should be called once, got %d", count1.Load())
	}
	if count2.Load() != 1 {
		t.Errorf("key2 fn should be called once, got %d", count2.Load())
	}
}
