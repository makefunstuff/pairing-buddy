package queue

import (
	"errors"
	"testing"
	"time"

	"example.com/hookd/internal/delivery"
	"example.com/hookd/internal/retry"
)

var cfg = delivery.Config{
	MaxAttempts:    5,
	Backoff:        retry.Backoff{Base: time.Second, Max: time.Minute},
	Budget:         15 * time.Second,
	AttemptTimeout: 5 * time.Second,
}

func TestLeaseOnce(t *testing.T) {
	q := New(cfg)
	if !q.Lease("evt_7", 0) || q.Lease("evt_7", time.Second) {
		t.Fatal("a leased job went to a second worker")
	}
}

func TestNoDoubleDelivery(t *testing.T) {
	q := New(cfg)
	q.Lease("evt_42", 0)
	attempts, _ := delivery.Deliver(cfg, func() error { return errors.New("503 from the receiver") })
	var start time.Duration
	for i, wait := range append([]time.Duration{0}, cfg.Backoff.Schedule(attempts)...) {
		start += wait
		if q.Lease("evt_42", start) {
			t.Fatalf("attempt %d starts at %v, when evt_42's lease runs out: a second worker takes it", i+1, start)
		}
	}
}
