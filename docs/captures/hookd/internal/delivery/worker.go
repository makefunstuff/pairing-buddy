package delivery

import (
	"errors"
	"time"

	"example.com/hookd/internal/retry"
)

// ErrBudget means the next retry would run past the job's time budget.
var ErrBudget = errors.New("retry budget spent")

// Config says how hard a worker tries before a webhook goes to the dead letters.
type Config struct {
	MaxAttempts int
	Backoff     retry.Backoff
	Budget      time.Duration // all waits together stay inside this
	// AttemptTimeout is how long one attempt may take.
	AttemptTimeout time.Duration
}

// Deliver sends a webhook, retrying with backoff until it succeeds or runs out of
// attempts or budget. It returns how many attempts it made.
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
