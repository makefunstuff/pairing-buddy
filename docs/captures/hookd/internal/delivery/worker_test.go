package delivery

import (
	"errors"
	"testing"
	"time"

	"example.com/hookd/internal/retry"
)

func TestDeliverRetriesUntilDeadLetter(t *testing.T) {
	cfg := Config{MaxAttempts: 5, Backoff: retry.Backoff{Base: time.Second, Max: time.Minute}, Budget: 15 * time.Second}
	attempts, _ := Deliver(cfg, func() error { return errors.New("503 from the receiver") })
	if attempts != 5 {
		t.Fatalf("attempts = %d, want 5 (1s+2s+4s+8s fits the 15s budget)", attempts)
	}
}
