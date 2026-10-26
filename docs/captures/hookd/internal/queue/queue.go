package queue

import (
	"time"

	"example.com/hookd/internal/delivery"
)

// Queue hands each job to one worker at a time. A worker leases the job, and
// the lease runs out after ttl, so a job whose worker died is picked up again.
type Queue struct {
	ttl    time.Duration
	leased map[string]time.Duration // job id -> when its lease runs out
}

// New makes a queue whose leases last as long as a delivery may retry.
func New(cfg delivery.Config) *Queue {
	return &Queue{ttl: cfg.Budget, leased: map[string]time.Duration{}}
}

// Lease gives job id to a worker at time now, unless another worker holds it.
func (q *Queue) Lease(id string, now time.Duration) bool {
	if end, ok := q.leased[id]; ok && now < end {
		return false
	}
	q.leased[id] = now + q.ttl
	return true
}
