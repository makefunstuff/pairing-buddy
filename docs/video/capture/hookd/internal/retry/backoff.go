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
		return b.Max // a longer shift wraps around
	}
	wait := b.Base << (attempt - 1)
	if wait > b.Max {
		return b.Max
	}
	return wait
}
