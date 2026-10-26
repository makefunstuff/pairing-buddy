package queue

import (
	"errors"
	"testing"
	"time"

	"example.com/hookd/internal/delivery"
	"example.com/hookd/internal/retry"
)

var cfg = delivery.Config{MaxAttempts: 8, Backoff: retry.Backoff{Base: time.Second, Max: time.Minute}, Budget: 15 * time.Second}

func TestLeaseOnce(t *testing.T) {
	q := New(cfg.Budget)
	if !q.Lease("evt_7", 0) || q.Lease("evt_7", time.Second) {
		t.Fatal("a leased event went to a second worker")
	}
}

func TestQueueLeaseOutlastsRetries(t *testing.T) {
	q := New(cfg.Budget)
	q.Lease("evt_42", 0)
	attempts, _ := delivery.Deliver(cfg, func() error { return errors.New("503 from the receiver") })
	var start time.Duration
	for n := 2; n <= attempts; n++ {
		start += cfg.Backoff.Next(n - 1)
		if q.Lease("evt_42", start) {
			t.Fatalf("attempt %d starts at %v, when evt_42's lease runs out: a second worker takes it", n, start)
		}
	}
}
