// Package site says whether a websiteId may receive events.
//
// The source is the view ingest_site(umami_website_id uuid, accepts_ingest
// boolean) in the stellytics database, created by the portal migrations and
// read by the stellytics_ingest user, which only has SELECT on it (E2 spec,
// sections 4 and 6). A site that is archived or belongs to a tenant that is not
// active comes with accepts_ingest false.
package site

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store answers whether the site exists and is active.
type Store interface {
	Active(ctx context.Context, websiteID string) (bool, error)
}

// PG queries ingest_site in Postgres.
type PG struct {
	Pool *pgxpool.Pool
}

// Active implements Store.
func (s PG) Active(ctx context.Context, websiteID string) (bool, error) {
	var accepts bool
	err := s.Pool.QueryRow(ctx,
		`SELECT accepts_ingest FROM ingest_site WHERE umami_website_id = $1`, websiteID,
	).Scan(&accepts)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return accepts, nil
}

// maxCached caps each of the cache's two maps.
const maxCached = 10_000

// queryTimeout bounds the query shared among the requests waiting for the same
// site. It does not inherit the cancellation of any request.
const queryTimeout = 5 * time.Second

// errBackoff is how long, after a failure, stale-if-error does not query the
// database again and answers immediately (simple circuit breaker).
const errBackoff = 2 * time.Second

// Cached keeps the answers of another Store for a short TTL. Errors are not
// cached as an answer.
//
// Accepted sites are kept in `entries` and refused or unknown ones in `neg`,
// each with its own cap. This way, whoever probes made-up IDs only fills the
// negative map and never evicts an accepted site.
//
// With WithStale, when the query fails, the last ACCEPTED answer for the same
// site is still valid for up to stale after it expires (stale-if-error). A site
// never seen, unknown or refused gets no stale answer: it stays with the error.
// Once stale has passed, the error returns. A revocation that happened during
// the failure only takes effect when the database comes back. There is only one
// query in flight per site. After a failure, a circuit breaker avoids new
// queries for errBackoff: the stale answer goes out immediately and a
// background probe tests the database.
type Cached struct {
	next    Store
	ttl     time.Duration
	stale   time.Duration
	timeout time.Duration
	backoff time.Duration
	now     func() time.Time

	staleServed atomic.Uint64

	mu       sync.Mutex
	entries  map[string]entry     // accepted
	neg      map[string]time.Time // refused or unknown: expiry
	inflight map[string]*call

	// circuit breaker (only with stale on)
	failed    bool
	failUntil time.Time
	lastErr   error
	probing   bool
}

type entry struct {
	expires time.Time
}

// call is the in-flight query for a site; whoever arrives later waits on done.
type call struct {
	done    chan struct{}
	active  bool
	err     error
	waiters int // protected by Cached.mu
}

// NewCached wraps next with a cache of ttl.
func NewCached(next Store, ttl time.Duration) *Cached {
	return &Cached{
		next: next, ttl: ttl, now: time.Now,
		timeout: queryTimeout, backoff: errBackoff,
		entries: make(map[string]entry), neg: make(map[string]time.Time),
		inflight: make(map[string]*call),
	}
}

// WithStale turns stale-if-error on: accepted answers that expired less than
// stale ago may be served when the query fails. Zero (the default) turns it
// off.
func (c *Cached) WithStale(stale time.Duration) *Cached {
	c.stale = stale
	return c
}

// StaleServed counts the stale answers served because of a database error.
func (c *Cached) StaleServed() uint64 { return c.staleServed.Load() }

// Active implements Store.
func (c *Cached) Active(ctx context.Context, websiteID string) (bool, error) {
	now := c.now()
	c.mu.Lock()
	e, known := c.entries[websiteID]
	if known && now.Before(e.expires) {
		c.mu.Unlock()
		return true, nil
	}
	if until, ok := c.neg[websiteID]; ok && now.Before(until) {
		c.mu.Unlock()
		return false, nil
	}

	// Circuit open: do not wait for the database. Serve the stale accepted
	// answer, if it fits within stale, or the last error; when the backoff
	// ends, a background probe tests the database.
	if c.stale > 0 && c.failed {
		if !now.Before(c.failUntil) && !c.probing && c.inflight[websiteID] == nil {
			c.probing = true
			cl := &call{done: make(chan struct{})}
			c.inflight[websiteID] = cl
			go c.fetch(websiteID, cl, true)
		}
		err := c.lastErr
		c.mu.Unlock()
		if known && now.Before(e.expires.Add(c.stale)) {
			c.staleServed.Add(1)
			return true, nil
		}
		return false, err
	}

	cl, running := c.inflight[websiteID]
	if !running {
		cl = &call{done: make(chan struct{})}
		c.inflight[websiteID] = cl
		go c.fetch(websiteID, cl, false)
	}
	cl.waiters++
	c.mu.Unlock()

	select {
	case <-cl.done:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	if cl.err == nil {
		return cl.active, nil
	}
	// Query failure: only an accepted entry that expired less than stale ago
	// can answer. The time is read again: the wait may have lasted until the
	// timeout.
	if c.stale > 0 && known && c.now().Before(e.expires.Add(c.stale)) {
		c.staleServed.Add(1)
		return true, nil
	}
	return false, cl.err
}

// fetch runs the query for a site and wakes whoever is waiting. It runs in its
// own goroutine so that the cancellation of one request does not take down the
// others.
func (c *Cached) fetch(websiteID string, cl *call, probe bool) {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	active, err := c.next.Active(ctx, websiteID)
	cl.active, cl.err = active, err

	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, websiteID)
	if probe {
		c.probing = false
	}
	if err != nil {
		if c.stale > 0 {
			c.failed, c.failUntil, c.lastErr = true, now.Add(c.backoff), err
		}
	} else {
		c.failed = false
		c.lastErr = nil
		c.store(websiteID, active, now)
	}
	close(cl.done)
}

// store writes the answer to the right map, respecting each one's cap. A new
// answer on one side erases the record on the other, so that a site that became
// refused does not come back through stale. The caller holds mu.
func (c *Cached) store(id string, active bool, now time.Time) {
	exp := now.Add(c.ttl)
	if active {
		delete(c.neg, id)
		if _, exists := c.entries[id]; !exists && len(c.entries) >= maxCached {
			c.evictAccepted(now)
		}
		c.entries[id] = entry{expires: exp}
		return
	}
	delete(c.entries, id)
	if _, exists := c.neg[id]; !exists && len(c.neg) >= maxCached {
		for k, until := range c.neg {
			if !now.Before(until) {
				delete(c.neg, k)
			}
		}
		if len(c.neg) >= maxCached {
			clear(c.neg) // only the negative map: accepted ones are not touched
		}
	}
	c.neg[id] = exp
}

// evictAccepted opens a slot among the accepted ones: first whichever is
// already past the useful window (TTL plus stale); if none is, the oldest.
func (c *Cached) evictAccepted(now time.Time) {
	var oldest string
	var oldestExp time.Time
	for k, e := range c.entries {
		if !now.Before(e.expires.Add(c.stale)) {
			delete(c.entries, k)
			continue
		}
		if oldest == "" || e.expires.Before(oldestExp) {
			oldest, oldestExp = k, e.expires
		}
	}
	if len(c.entries) >= maxCached && oldest != "" {
		delete(c.entries, oldest)
	}
}
