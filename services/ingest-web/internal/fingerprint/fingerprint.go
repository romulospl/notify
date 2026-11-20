// Package fingerprint is suspicious of many different browsers on the same IP
// (#26).
//
// The fingerprint is a hash of User-Agent, Accept-Language, language and
// screen. It does not identify a person (many people have the same combination)
// and only exists in memory, for a short window. Per truncated IP and site, the
// Counter accepts up to Limit distinct fingerprints seen within the window;
// events from fingerprints beyond that are dropped. A bot that changes
// User-Agent on every request, from a single IP, does not inflate the metrics;
// the first fingerprints of the IP keep counting normally.
//
// The count is separate per site: a bot in the same /24 (or behind the same
// CGNAT) that fills the quota of its own site does not take the slots of other
// tenants' sites.
package fingerprint

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"net/netip"
	"sync"
	"time"
)

// Of computes the fingerprint of an event. The fields are separated by a zero
// byte so that "ab"+"c" and "a"+"bc" give different hashes.
func Of(userAgent, acceptLanguage, language, screen string) uint64 {
	h := sha256.New()
	for _, s := range []string{userAgent, acceptLanguage, language, screen} {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	return binary.BigEndian.Uint64(h.Sum(nil)[:8])
}

// Counter counts distinct fingerprints per truncated IP in a sliding window.
type Counter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu   sync.Mutex
	keys map[key]map[uint64]time.Time
}

// key is the count: the truncated IP and the site (lowercase UUID).
type key struct {
	ip   netip.Addr
	site string
}

// New creates a Counter that accepts up to limit fingerprints per IP in window.
// limit 0 turns the check off.
func New(limit int, window time.Duration) *Counter {
	return &Counter{limit: limit, window: window, now: time.Now, keys: make(map[key]map[uint64]time.Time)}
}

// WithClock replaces the clock (for tests) and returns the Counter itself.
func (c *Counter) WithClock(now func() time.Time) *Counter {
	c.now = now
	return c
}

// Allow records fp in the count of truncated IP ip on the site and says whether
// the event may proceed. A fingerprint already seen in the window always
// proceeds; a new one only gets in while the count has fewer than limit active
// fingerprints.
func (c *Counter) Allow(ip netip.Addr, site string, fp uint64) bool {
	ok, _ := c.Admit(ip, site, fp)
	return ok
}

// Admit is Allow that also says whether the fingerprint entered the count just
// now (fresh). Whoever drops the event later for another reason (relay
// saturation) calls Forget when fresh is true, so that the drop does not spend
// one of the IP's fingerprint slots.
func (c *Counter) Admit(ip netip.Addr, site string, fp uint64) (ok, fresh bool) {
	if c.limit <= 0 {
		return true, false
	}
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()

	k := key{ip, site}
	seen := c.keys[k]
	if seen == nil {
		seen = make(map[uint64]time.Time)
		c.keys[k] = seen
	}
	if _, ok := seen[fp]; ok {
		seen[fp] = now
		return true, false
	}
	if len(seen) >= c.limit {
		c.expire(seen, now)
		if len(seen) >= c.limit {
			return false, false
		}
	}
	seen[fp] = now
	return true, true
}

// Forget removes fp from the count of truncated IP ip on the site. Only to undo
// an Admit that returned fresh.
func (c *Counter) Forget(ip netip.Addr, site string, fp uint64) {
	if c.limit <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	k := key{ip, site}
	if seen := c.keys[k]; seen != nil {
		delete(seen, fp)
		if len(seen) == 0 {
			delete(c.keys, k)
		}
	}
}

func (c *Counter) expire(seen map[uint64]time.Time, now time.Time) {
	cutoff := now.Add(-c.window)
	for fp, at := range seen {
		if at.Before(cutoff) {
			delete(seen, fp)
		}
	}
}

// Sweep removes from memory the fingerprints outside the window and the counts
// left with none.
func (c *Counter) Sweep() {
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, seen := range c.keys {
		c.expire(seen, now)
		if len(seen) == 0 {
			delete(c.keys, k)
		}
	}
}

// Len says how many counts (IP and site) are in memory.
func (c *Counter) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.keys)
}

// Run calls Sweep at each every interval until the context ends.
func (c *Counter) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.Sweep()
		}
	}
}
