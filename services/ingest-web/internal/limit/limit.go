// Package limit applies a token bucket per key (the already truncated IP).
package limit

import (
	"context"
	"net/netip"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter keeps one rate.Limiter per key, in memory only.
type Limiter struct {
	rate  rate.Limit
	burst int
	idle  time.Duration
	now   func() time.Time

	mu      sync.Mutex
	buckets map[netip.Addr]*bucket
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

// New creates a Limiter with perSecond events per second and a burst of burst.
// Keys unused for longer than idle are removed by Run.
func New(perSecond float64, burst int, idle time.Duration) *Limiter {
	return &Limiter{
		rate:    rate.Limit(perSecond),
		burst:   burst,
		idle:    idle,
		now:     time.Now,
		buckets: make(map[netip.Addr]*bucket),
	}
}

// Allow consumes a token from the key and says whether the event may proceed.
func (l *Limiter) Allow(key netip.Addr) bool {
	now := l.now()
	l.mu.Lock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{lim: rate.NewLimiter(l.rate, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	l.mu.Unlock()
	return b.lim.AllowN(now, 1)
}

// Sweep removes the keys idle for longer than idle.
func (l *Limiter) Sweep() {
	cutoff := l.now().Add(-l.idle)
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.buckets {
		if b.seen.Before(cutoff) {
			delete(l.buckets, k)
		}
	}
}

// Len says how many keys are in memory.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Run calls Sweep at each every interval until the context ends.
func (l *Limiter) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.Sweep()
		}
	}
}
