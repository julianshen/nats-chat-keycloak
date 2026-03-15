package main

import (
	"fmt"
	"sort"
	"sync"
	"testing"
)

func TestLRUCache_GetSet(t *testing.T) {
	t.Run("get from empty cache returns miss", func(t *testing.T) {
		c := newLRUCache(10)
		_, ok := c.get("room1")
		if ok {
			t.Error("expected miss on empty cache")
		}
	})

	t.Run("set then get returns members", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice", "bob"})
		members, ok := c.get("room1")
		if !ok {
			t.Fatal("expected hit")
		}
		if len(members) != 2 {
			t.Errorf("expected 2 members, got %d", len(members))
		}
	})

	t.Run("set same key updates value", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice"})
		c.set("room1", []string{"alice", "bob", "charlie"})
		members, ok := c.get("room1")
		if !ok {
			t.Fatal("expected hit")
		}
		if len(members) != 3 {
			t.Errorf("expected 3 members, got %d", len(members))
		}
	})

	t.Run("eviction at capacity removes oldest", func(t *testing.T) {
		c := newLRUCache(2)
		c.set("room1", []string{"alice"})
		c.set("room2", []string{"bob"})
		c.set("room3", []string{"charlie"})
		_, ok := c.get("room1")
		if ok {
			t.Error("room1 should have been evicted")
		}
		_, ok = c.get("room2")
		if !ok {
			t.Error("room2 should still be cached")
		}
		_, ok = c.get("room3")
		if !ok {
			t.Error("room3 should still be cached")
		}
	})

	t.Run("get moves to front preventing eviction", func(t *testing.T) {
		c := newLRUCache(2)
		c.set("room1", []string{"alice"})
		c.set("room2", []string{"bob"})
		c.get("room1")
		c.set("room3", []string{"charlie"})
		_, ok := c.get("room1")
		if !ok {
			t.Error("room1 should still be cached (was accessed recently)")
		}
		_, ok = c.get("room2")
		if ok {
			t.Error("room2 should have been evicted (LRU)")
		}
	})
}

func TestLRUCache_ApplyDelta(t *testing.T) {
	t.Run("join adds member to existing room", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice"})
		ok := c.applyDelta("room1", "join", "bob")
		if !ok {
			t.Error("expected true for cached room")
		}
		members, _ := c.get("room1")
		sort.Strings(members)
		if len(members) != 2 || members[0] != "alice" || members[1] != "bob" {
			t.Errorf("expected [alice bob], got %v", members)
		}
	})

	t.Run("leave removes member from existing room", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice", "bob"})
		c.applyDelta("room1", "leave", "alice")
		members, _ := c.get("room1")
		if len(members) != 1 || members[0] != "bob" {
			t.Errorf("expected [bob], got %v", members)
		}
	})

	t.Run("leave last member removes room from cache", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice"})
		c.applyDelta("room1", "leave", "alice")
		_, ok := c.get("room1")
		if ok {
			t.Error("room should be removed after last member leaves")
		}
		if c.roomCount() != 0 {
			t.Errorf("expected 0 rooms, got %d", c.roomCount())
		}
	})

	t.Run("join on uncached room returns false", func(t *testing.T) {
		c := newLRUCache(10)
		ok := c.applyDelta("room1", "join", "alice")
		if ok {
			t.Error("expected false for uncached room")
		}
	})

	t.Run("leave on uncached room returns false", func(t *testing.T) {
		c := newLRUCache(10)
		ok := c.applyDelta("room1", "leave", "alice")
		if ok {
			t.Error("expected false for uncached room")
		}
	})
}

func TestLRUCache_IsMember(t *testing.T) {
	c := newLRUCache(10)
	c.set("room1", []string{"alice", "bob"})

	t.Run("existing member", func(t *testing.T) {
		member, cached := c.isMember("room1", "alice")
		if !member || !cached {
			t.Errorf("expected (true, true), got (%v, %v)", member, cached)
		}
	})

	t.Run("non-member in cached room", func(t *testing.T) {
		member, cached := c.isMember("room1", "charlie")
		if member || !cached {
			t.Errorf("expected (false, true), got (%v, %v)", member, cached)
		}
	})

	t.Run("uncached room", func(t *testing.T) {
		member, cached := c.isMember("room2", "alice")
		if member || cached {
			t.Errorf("expected (false, false), got (%v, %v)", member, cached)
		}
	})
}

func TestLRUCache_Metrics(t *testing.T) {
	t.Run("reflects current state", func(t *testing.T) {
		c := newLRUCache(10)
		c.set("room1", []string{"alice", "bob"})
		c.set("room2", []string{"charlie"})

		if c.roomCount() != 2 {
			t.Errorf("expected 2 rooms, got %d", c.roomCount())
		}
		if c.totalMembers() != 3 {
			t.Errorf("expected 3 total members, got %d", c.totalMembers())
		}
	})

	t.Run("counts decrease after eviction", func(t *testing.T) {
		c := newLRUCache(2)
		c.set("room1", []string{"alice"})
		c.set("room2", []string{"bob"})
		c.set("room3", []string{"charlie"})
		if c.roomCount() != 2 {
			t.Errorf("expected 2 rooms after eviction, got %d", c.roomCount())
		}
		if c.totalMembers() != 2 {
			t.Errorf("expected 2 total members after eviction, got %d", c.totalMembers())
		}
	})
}

func TestLRUCache_Concurrency(t *testing.T) {
	c := newLRUCache(50)
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			room := fmt.Sprintf("room%d", id%5)
			for j := 0; j < 100; j++ {
				c.set(room, []string{fmt.Sprintf("user%d", j)})
				c.get(room)
				c.applyDelta(room, "join", fmt.Sprintf("extra%d", j))
				c.isMember(room, fmt.Sprintf("user%d", j))
				c.roomCount()
				c.totalMembers()
			}
		}(i)
	}
	wg.Wait()
}
