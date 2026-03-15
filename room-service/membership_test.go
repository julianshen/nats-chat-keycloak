package main

import (
	"fmt"
	"sort"
	"sync"
	"testing"
)

func TestLocalMembership_AddRemove(t *testing.T) {
	t.Run("add user to room", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		members := m.members("room1")
		if len(members) != 1 || members[0] != "alice" {
			t.Errorf("expected [alice], got %v", members)
		}
	})

	t.Run("add duplicate is idempotent", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.add("room1", "alice")
		members := m.members("room1")
		if len(members) != 1 {
			t.Errorf("expected 1 member after duplicate add, got %d", len(members))
		}
	})

	t.Run("remove user from room", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.add("room1", "bob")
		m.remove("room1", "alice")
		members := m.members("room1")
		if len(members) != 1 || members[0] != "bob" {
			t.Errorf("expected [bob], got %v", members)
		}
	})

	t.Run("remove non-existent user is no-op", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.remove("room1", "bob")
		members := m.members("room1")
		if len(members) != 1 {
			t.Errorf("expected 1 member, got %d", len(members))
		}
	})

	t.Run("remove last user deletes room", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.remove("room1", "alice")
		members := m.members("room1")
		if members != nil {
			t.Errorf("expected nil for empty room, got %v", members)
		}
		if m.roomCount() != 0 {
			t.Errorf("expected 0 rooms, got %d", m.roomCount())
		}
	})
}

func TestLocalMembership_Members(t *testing.T) {
	t.Run("non-existent room returns nil", func(t *testing.T) {
		m := newLocalMembership()
		if m.members("room1") != nil {
			t.Error("expected nil for non-existent room")
		}
	})

	t.Run("multiple users returned", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		m.add("room1", "bob")
		m.add("room1", "charlie")
		members := m.members("room1")
		sort.Strings(members)
		if len(members) != 3 || members[0] != "alice" || members[1] != "bob" || members[2] != "charlie" {
			t.Errorf("expected [alice bob charlie], got %v", members)
		}
	})

	t.Run("members is a snapshot", func(t *testing.T) {
		m := newLocalMembership()
		m.add("room1", "alice")
		members := m.members("room1")
		members[0] = "hacked"
		actual := m.members("room1")
		if actual[0] != "alice" {
			t.Error("modifying returned slice should not affect internal state")
		}
	})
}

func TestLocalMembership_Reset(t *testing.T) {
	m := newLocalMembership()
	m.add("room1", "alice")
	m.add("room2", "bob")
	m.reset()

	if m.roomCount() != 0 {
		t.Errorf("expected 0 rooms after reset, got %d", m.roomCount())
	}
	if m.members("room1") != nil {
		t.Error("expected nil after reset")
	}
}

func TestLocalMembership_SwapFrom(t *testing.T) {
	t.Run("target gets source data", func(t *testing.T) {
		source := newLocalMembership()
		source.add("room1", "alice")
		source.add("room2", "bob")

		target := newLocalMembership()
		target.add("room3", "charlie")
		target.swapFrom(source)

		if target.roomCount() != 2 {
			t.Errorf("expected target to have 2 rooms, got %d", target.roomCount())
		}
		members := target.members("room1")
		if len(members) != 1 || members[0] != "alice" {
			t.Errorf("expected target room1 = [alice], got %v", members)
		}
		if target.members("room3") != nil {
			t.Error("target should not have old room3 data")
		}
	})

	t.Run("source retains data after swap", func(t *testing.T) {
		source := newLocalMembership()
		source.add("room1", "alice")

		target := newLocalMembership()
		target.swapFrom(source)

		if source.roomCount() != 1 {
			t.Errorf("source should retain data, got roomCount=%d", source.roomCount())
		}
	})
}

func TestLocalMembership_Concurrency(t *testing.T) {
	m := newLocalMembership()
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			room := fmt.Sprintf("room%d", id%3)
			user := fmt.Sprintf("user%d", id)
			for j := 0; j < 100; j++ {
				m.add(room, user)
				m.members(room)
				m.roomCount()
				m.remove(room, user)
			}
		}(i)
	}
	wg.Wait()
}
