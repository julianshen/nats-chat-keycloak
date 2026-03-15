package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

type LeaderElection struct {
	kv           jetstream.KeyValue
	instanceID   string
	key          string
	ttl          time.Duration
	heartbeatInt time.Duration
	isLeader     atomic.Bool
	stopCh       chan struct{}
}

func NewLeaderElection(js jetstream.JetStream, bucket, key string, ttl, heartbeatInt time.Duration) (*LeaderElection, error) {
	kv, err := js.CreateKeyValue(context.Background(), jetstream.KeyValueConfig{
		Bucket: bucket,
		TTL:    ttl,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create KV bucket: %w", err)
	}

	b := make([]byte, 4)
	rand.Read(b)
	instanceID := hex.EncodeToString(b)

	return &LeaderElection{
		kv:           kv,
		instanceID:   instanceID,
		key:          key,
		ttl:          ttl,
		heartbeatInt: heartbeatInt,
		stopCh:       make(chan struct{}),
	}, nil
}

func (le *LeaderElection) InstanceID() string {
	return le.instanceID
}

func (le *LeaderElection) IsLeader() bool {
	return le.isLeader.Load()
}

func (le *LeaderElection) Start(ctx context.Context) {
	ticker := time.NewTicker(le.heartbeatInt)
	defer ticker.Stop()

	le.tryBecomeLeader(ctx)

	for {
		select {
		case <-ctx.Done():
			le.stepDown()
			return
		case <-le.stopCh:
			le.stepDown()
			return
		case <-ticker.C:
			if le.isLeader.Load() {
				le.renewLeadership(ctx)
			} else {
				le.tryBecomeLeader(ctx)
			}
		}
	}
}

func (le *LeaderElection) Stop() {
	close(le.stopCh)
}

func (le *LeaderElection) tryBecomeLeader(ctx context.Context) {
	_, err := le.kv.Create(ctx, le.key, []byte(le.instanceID))
	if err == nil {
		le.isLeader.Store(true)
		slog.Info("Became leader", "instance_id", le.instanceID, "key", le.key)
		return
	}

	entry, err := le.kv.Get(ctx, le.key)
	if err != nil {
		slog.Debug("No current leader, will retry", "error", err)
		return
	}

	currentLeader := string(entry.Value())
	if currentLeader == le.instanceID {
		le.isLeader.Store(true)
	}
}

func (le *LeaderElection) renewLeadership(ctx context.Context) {
	entry, err := le.kv.Get(ctx, le.key)
	if err != nil {
		slog.Warn("Lost leadership - key not found", "instance_id", le.instanceID)
		le.isLeader.Store(false)
		return
	}

	currentLeader := string(entry.Value())
	if currentLeader != le.instanceID {
		slog.Warn("Lost leadership - another instance is leader", "instance_id", le.instanceID, "current_leader", currentLeader)
		le.isLeader.Store(false)
		return
	}

	_, err = le.kv.Update(ctx, le.key, []byte(le.instanceID), entry.Revision())
	if err != nil {
		slog.Warn("Failed to renew leadership", "instance_id", le.instanceID, "error", err)
		le.isLeader.Store(false)
	}
}

func (le *LeaderElection) stepDown() {
	if le.isLeader.Load() {
		entry, err := le.kv.Get(context.Background(), le.key)
		if err == nil && string(entry.Value()) == le.instanceID {
			le.kv.Delete(context.Background(), le.key)
			slog.Info("Stepped down as leader", "instance_id", le.instanceID)
		}
		le.isLeader.Store(false)
	}
}
