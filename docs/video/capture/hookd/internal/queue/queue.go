// Package queue leases events to workers, one worker per event at a time.
package queue

import "time"

// Queue remembers which event is leased until when.
type Queue struct {
	ttl    time.Duration
	leased map[string]time.Duration
}

// New is a queue whose leases last ttl.
func New(ttl time.Duration) *Queue {
	return &Queue{ttl: ttl, leased: map[string]time.Duration{}}
}

// Lease gives the event to the caller at time now, unless another worker holds it.
func (q *Queue) Lease(event string, now time.Duration) bool {
	if until, ok := q.leased[event]; ok && now < until {
		return false
	}
	q.leased[event] = now + q.ttl
	return true
}
