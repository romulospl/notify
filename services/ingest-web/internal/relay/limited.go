package relay

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// ErrSaturated means no relay slot came up within QueueWait: the event is
// dropped, not deferred.
var ErrSaturated = errors.New("relay: concurrent relays at the limit")

// Sender is what the gateway uses to relay an event.
type Sender interface {
	Send(ctx context.Context, ev Event, userAgent string, truncatedIP netip.Addr) error
}

// Limited limits how many relays to Umami run at the same time (semaphore).
// Whoever arrives with all the slots taken waits up to wait for one; once the
// deadline passes, Send returns ErrSaturated without touching Umami. This way
// the gateway never holds more than max requests in Umami nor more than
// (arrivals per second x wait) waiting for a slot, instead of piling everything
// up while Umami is slow.
//
// The slot is returned by defer: error, timeout, client cancellation and a
// panic in the Sender release it.
type Limited struct {
	next    Sender
	slots   chan struct{}
	wait    time.Duration
	dropped atomic.Uint64
	mu      sync.Mutex
	bySite  map[string]int
	changed chan struct{}
}

// NewLimited wraps next with up to max concurrent relays and a wait of up to
// wait for a slot (wait 0 refuses immediately). max must be greater than zero.
func NewLimited(next Sender, max int, wait time.Duration) *Limited {
	return &Limited{next: next, slots: make(chan struct{}, max), wait: wait, bySite: make(map[string]int), changed: make(chan struct{})}
}

// Send relays ev when there is a slot (or one comes up in time).
func (l *Limited) Send(ctx context.Context, ev Event, userAgent string, truncatedIP netip.Addr) error {
	if err := l.acquire(ctx, ev.Payload.Website); err != nil {
		return err
	}
	defer l.release(ev.Payload.Website)
	return l.next.Send(ctx, ev, userAgent, truncatedIP)
}

// One slot stays reserved for other sites when there are at least two. The map
// only holds sites with active relays and has at most cap(slots) entries.
func (l *Limited) acquire(ctx context.Context, site string) error {
	var timer *time.Timer
	if l.wait > 0 {
		timer = time.NewTimer(l.wait)
		defer timer.Stop()
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		l.mu.Lock()
		limit := cap(l.slots)
		if limit > 1 {
			limit--
		}
		if len(l.slots) < cap(l.slots) && l.bySite[site] < limit {
			l.slots <- struct{}{}
			l.bySite[site]++
			l.mu.Unlock()
			return nil
		}
		changed := l.changed
		l.mu.Unlock()
		if timer == nil {
			l.dropped.Add(1)
			return ErrSaturated
		}
		select {
		case <-changed:
		case <-timer.C:
			l.dropped.Add(1)
			return ErrSaturated
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (l *Limited) release(site string) {
	l.mu.Lock()
	<-l.slots
	l.bySite[site]--
	if l.bySite[site] == 0 {
		delete(l.bySite, site)
	}
	close(l.changed)
	l.changed = make(chan struct{})
	l.mu.Unlock()
}

// Dropped is the total number of events refused because of saturation since the
// start.
func (l *Limited) Dropped() uint64 { return l.dropped.Load() }

// InFlight is how many relays are in progress now.
func (l *Limited) InFlight() int { return len(l.slots) }
