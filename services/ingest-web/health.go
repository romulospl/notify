package main

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// healthTimeout bounds each dependency check; the container's -healthcheck
// waits 3 s.
const healthTimeout = 2 * time.Second

// cachedHealth keeps the check result for ttl. /healthz is public: without the
// cache, each request would become a query to Postgres and Umami. Whoever
// arrives during a check waits for it instead of starting another.
type cachedHealth struct {
	check func(context.Context) error
	ttl   time.Duration
	now   func() time.Time

	mu  sync.Mutex
	at  time.Time
	err error
}

func newCachedHealth(ttl time.Duration, check func(context.Context) error) *cachedHealth {
	return &cachedHealth{check: check, ttl: ttl, now: time.Now}
}

func (h *cachedHealth) Check(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.at.IsZero() && h.now().Sub(h.at) < h.ttl {
		return h.err
	}
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	h.err = h.check(ctx)
	h.at = h.now()
	return h.err
}

// healthz answers 200 only when the gateway can deliver events: Postgres
// (ingest_site, and where Umami writes) and Umami respond. It is what external
// monitoring measures as web ingestion availability.
func (g *gateway) healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if g.health != nil {
		if err := g.health(r.Context()); err != nil {
			g.log.Warn("healthz: dependency down", "err", err)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("unavailable\n"))
			return
		}
	}
	_, _ = w.Write([]byte("ok\n"))
}
