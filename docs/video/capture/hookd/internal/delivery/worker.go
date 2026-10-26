// Package delivery sends one webhook event, retrying until it lands or the budget is spent.
package delivery

import (
	"errors"
	"time"

	"example.com/hookd/internal/retry"
)

// Config says how hard a worker tries.
type Config struct {
	MaxAttempts int
	Backoff     retry.Backoff
	Budget      time.Duration // the longest a worker waits, in total, between attempts
}

// ErrBudget: the next wait would go past the budget, so the event goes to the dead letters.
var ErrBudget = errors.New("retry budget spent")

// Deliver calls send until it succeeds, MaxAttempts is reached or the budget is spent.
// It returns how many attempts it made. Time is counted, not slept.
func Deliver(cfg Config, send func() error) (int, error) {
	var elapsed time.Duration
	for attempt := 1; ; attempt++ {
		err := send()
		if err == nil {
			return attempt, nil
		}
		if attempt == cfg.MaxAttempts {
			return attempt, err
		}
		wait := cfg.Backoff.Next(attempt)
		if elapsed+wait >= cfg.Budget {
			return attempt, ErrBudget
		}
		elapsed += wait
	}
}
