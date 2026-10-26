package retry

import (
	"testing"
	"time"
)

func TestNext(t *testing.T) {
	b := Backoff{Base: time.Second, Max: time.Minute}
	cases := []struct {
		name    string
		attempt int
		want    time.Duration
	}{
		{"first retry waits the base", 1, time.Second},
	}
	for _, c := range cases {
		if got := b.Next(c.attempt); got != c.want {
			t.Errorf("%s: Next(%d) = %v, want %v", c.name, c.attempt, got, c.want)
		}
	}
}
