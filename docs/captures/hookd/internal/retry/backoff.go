// Package retry decides how long a failed delivery waits before the next attempt.
package retry

import "time"

// Backoff waits Base after the first attempt, then twice as long each time, up to Max.
type Backoff struct {
	Base time.Duration // wait after the first attempt
	Max  time.Duration // no wait is longer than this
}

// Next is the wait after the given attempt (1-based): Base, 2·Base, 4·Base, ...
func (b Backoff) Next(attempt int) time.Duration {
	if attempt < 1 {
		return 0
	}
	if attempt > 32 {
		return b.Max // Base << 63 wraps around to a negative wait
	}
	wait := b.Base << (attempt - 1)
	if wait > b.Max {
		return b.Max
	}
	return wait
}

// Schedule lists the waits for n attempts, for logs and the admin page.
func (b Backoff) Schedule(n int) []time.Duration {
	waits := make([]time.Duration, 0, n)
	for attempt := 1; attempt < n; attempt++ {
		waits = append(waits, b.Next(attempt))
	}
	return waits
}
