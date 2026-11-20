package site

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
)

type countingStore struct {
	calls  int
	active map[string]bool
	err    error
}

func (s *countingStore) Active(_ context.Context, id string) (bool, error) {
	s.calls++
	return s.active[id], s.err
}

func TestCachedKeepsPositiveAndNegative(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	next := &countingStore{active: map[string]bool{"a": true}}
	c := NewCached(next, time.Minute)
	c.now = func() time.Time { return now }
	ctx := context.Background()

	for range 3 {
		if ok, _ := c.Active(ctx, "a"); !ok {
			t.Fatal("a should be active")
		}
		if ok, _ := c.Active(ctx, "b"); ok {
			t.Fatal("b should not be active")
		}
	}
	if next.calls != 2 {
		t.Fatalf("queries = %d, want 2", next.calls)
	}

	// After the TTL, the answer is fetched again.
	next.active["b"] = true
	now = now.Add(time.Minute)
	if ok, _ := c.Active(ctx, "b"); !ok {
		t.Fatal("b was not updated after the TTL")
	}
	if next.calls != 3 {
		t.Fatalf("queries = %d, want 3", next.calls)
	}
}

func TestCachedDoesNotKeepErrors(t *testing.T) {
	next := &countingStore{err: errors.New("database down")}
	c := NewCached(next, time.Minute)
	ctx := context.Background()
	for range 2 {
		if _, err := c.Active(ctx, "a"); err == nil {
			t.Fatal("error not passed on")
		}
	}
	if next.calls != 2 {
		t.Fatalf("queries = %d, want 2", next.calls)
	}
}

func TestCachedIsBounded(t *testing.T) {
	c := NewCached(&countingStore{}, time.Hour)
	ctx := context.Background()
	for i := range maxCached + 10 {
		_, _ = c.Active(ctx, string(rune(i)))
	}
	if n := len(c.neg); n > maxCached {
		t.Fatalf("cache with %d entries, limit %d", n, maxCached)
	}
}

// flakyStore switches between answers and failures and is safe for concurrent
// use.
type flakyStore struct {
	mu      sync.Mutex
	calls   int
	active  map[string]bool
	fail    bool
	gate    chan struct{} // if non-nil, Active waits on it (or on ctx)
	started chan struct{} // if non-nil, receives a signal for each query started
}

func (s *flakyStore) Active(ctx context.Context, id string) (bool, error) {
	s.mu.Lock()
	s.calls++
	fail, a, gate, started := s.fail, s.active[id], s.gate, s.started
	s.mu.Unlock()
	if started != nil {
		started <- struct{}{}
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
	if fail {
		return false, errors.New("database down")
	}
	return a, nil
}

func (s *flakyStore) set(fail bool) {
	s.mu.Lock()
	s.fail = fail
	s.mu.Unlock()
}

func (s *flakyStore) setGate(g chan struct{}) {
	s.mu.Lock()
	s.gate = g
	s.mu.Unlock()
}

func (s *flakyStore) n() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// testClock is a controlled clock, safe for concurrent use.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (k *testClock) now() time.Time {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.t
}

func (k *testClock) add(d time.Duration) {
	k.mu.Lock()
	k.t = k.t.Add(d)
	k.mu.Unlock()
}

func newStale(stale time.Duration) (*Cached, *flakyStore, *testClock) {
	clk := &testClock{t: time.Unix(1_700_000_000, 0)}
	next := &flakyStore{active: map[string]bool{"live": true, "gone": false}}
	c := NewCached(next, time.Minute).WithStale(stale)
	c.now = clk.now
	return c, next, clk
}

// Regression: with stale 0, the database error is still passed on, even with a
// known, expired entry, and the circuit breaker does not act.
func TestStaleOffKeepsErrors(t *testing.T) {
	c, next, clk := newStale(0)
	ctx := context.Background()
	if ok, err := c.Active(ctx, "live"); !ok || err != nil {
		t.Fatal("should accept")
	}
	next.set(true)
	clk.add(2 * time.Minute)
	base := next.n()
	for range 3 {
		if _, err := c.Active(ctx, "live"); err == nil {
			t.Fatal("without stale, the error should go through")
		}
	}
	if got := next.n() - base; got != 3 {
		t.Fatalf("without stale each call queries the database: %d queries, want 3", got)
	}
	if c.StaleServed() != 0 {
		t.Fatal("counter should be zero")
	}
}

func TestStaleServesKnownSiteUntilTTL(t *testing.T) {
	c, next, clk := newStale(10 * time.Minute)
	ctx := context.Background()
	c.Active(ctx, "live")
	next.set(true)

	clk.add(time.Minute) // expired, within stale
	if ok, err := c.Active(ctx, "live"); !ok || err != nil {
		t.Fatalf("should serve the stale one: %v %v", ok, err)
	}
	clk.add(9*time.Minute + 59*time.Second) // still within (expired < 10 min ago)
	if ok, err := c.Active(ctx, "live"); !ok || err != nil {
		t.Fatalf("still within stale: %v %v", ok, err)
	}
	if c.StaleServed() != 2 {
		t.Fatalf("counter = %d, want 2", c.StaleServed())
	}
	clk.add(2 * time.Second) // past stale
	if _, err := c.Active(ctx, "live"); err == nil {
		t.Fatal("after stale the error should return")
	}
	if c.StaleServed() != 2 {
		t.Fatal("an error does not count as a stale one served")
	}
}

func TestStaleNeverAcceptsUnknownSite(t *testing.T) {
	c, next, _ := newStale(time.Hour)
	next.set(true)
	ok, err := c.Active(context.Background(), "live") // never seen
	if ok || err == nil {
		t.Fatalf("site never seen: ok=%v err=%v, want an error", ok, err)
	}
}

// A refused site never becomes accepted for being expired, and gets no stale
// answer.
func TestStaleNeverTurnsRefusedIntoAccepted(t *testing.T) {
	c, next, clk := newStale(time.Hour)
	ctx := context.Background()
	c.Active(ctx, "gone")
	next.set(true)
	clk.add(5 * time.Minute)
	if ok, _ := c.Active(ctx, "gone"); ok {
		t.Fatal("a refused one can never become accepted")
	}
	// An accepted site that becomes refused loses the accepted entry.
	next.set(false)
	next.mu.Lock()
	next.active["live"] = true
	next.mu.Unlock()
	c.Active(ctx, "live")
	next.mu.Lock()
	next.active["live"] = false
	next.mu.Unlock()
	clk.add(2 * time.Minute)
	c.Active(ctx, "live") // comes back refused
	next.set(true)
	clk.add(2 * time.Minute)
	if ok, _ := c.Active(ctx, "live"); ok {
		t.Fatal("a site that became refused must not come back through stale")
	}
}

// A revocation during the failure only takes effect when the database comes
// back.
func TestStaleRevocationAppliesWhenDBReturns(t *testing.T) {
	c, next, clk := newStale(time.Hour)
	ctx := context.Background()
	c.Active(ctx, "live")
	next.set(true)
	next.mu.Lock()
	next.active["live"] = false // removed during the outage
	next.mu.Unlock()
	clk.add(5 * time.Minute)
	if ok, _ := c.Active(ctx, "live"); !ok {
		t.Fatal("during the outage the stale answer is still valid")
	}
	next.set(false)
	clk.add(errBackoff) // the circuit lets the probe through
	// The probe runs in the background; the first call still gets the stale
	// one.
	deadline := time.Now().Add(2 * time.Second)
	for {
		ok, err := c.Active(ctx, "live")
		if !ok && err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("with the database back it should refuse: %v %v", ok, err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// waitWaiters waits, without sleeping blindly, until n requests are stuck on
// the in-flight query for id.
func waitWaiters(t *testing.T, c *Cached, id string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		cl := c.inflight[id]
		got := 0
		if cl != nil {
			got = cl.waiters
		}
		c.mu.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiters = %d, want %d", got, n)
		}
		runtime.Gosched()
	}
}

func TestStaleSingleFlight(t *testing.T) {
	c, next, clk := newStale(time.Hour)
	ctx := context.Background()
	c.Active(ctx, "live")
	base := next.n()
	next.set(true)
	gate := make(chan struct{})
	next.setGate(gate)
	clk.add(5 * time.Minute)

	const n = 50
	var wg sync.WaitGroup
	results := make(chan bool, n)
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := c.Active(ctx, "live")
			results <- ok && err == nil
		}()
	}
	waitWaiters(t, c, "live", n)
	close(gate)
	wg.Wait()
	close(results)
	for r := range results {
		if !r {
			t.Fatal("all of them should get the stale answer")
		}
	}
	if got := next.n() - base; got != 1 {
		t.Fatalf("queries in flight = %d, want 1", got)
	}
}

func TestCanceledWaiterDoesNotBreakOthers(t *testing.T) {
	c, next, _ := newStale(0)
	gate := make(chan struct{})
	started := make(chan struct{}, 1)
	next.mu.Lock()
	next.gate, next.started = gate, started
	next.mu.Unlock()
	cctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { _, err := c.Active(cctx, "live"); errc <- err }()
	<-started
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("whoever cancelled should get an error")
	}
	close(gate)
	// The shared query went on: this call joins it or reads the cache.
	if ok, err := c.Active(context.Background(), "live"); !ok || err != nil {
		t.Fatalf("the shared query should have been reused: %v %v", ok, err)
	}
}

// Made-up IDs only fill the negative map: the accepted site survives, also
// during the database failure.
func TestStaleSaturationKeepsAcceptedSite(t *testing.T) {
	c, next, clk := newStale(time.Hour)
	ctx := context.Background()
	if ok, _ := c.Active(ctx, "live"); !ok {
		t.Fatal("should accept")
	}
	// Fills the cache with more negatives than the cap.
	for i := range maxCached + 500 {
		_, _ = c.Active(ctx, fmt.Sprintf("fake-%d", i))
	}
	c.mu.Lock()
	if len(c.neg) > maxCached || len(c.entries) != 1 {
		t.Fatalf("neg=%d entries=%d", len(c.neg), len(c.entries))
	}
	c.mu.Unlock()

	// The database goes down; more made-up IDs, and the good site keeps being
	// served stale.
	next.set(true)
	clk.add(5 * time.Minute)
	for i := range 3000 {
		if ok, _ := c.Active(ctx, fmt.Sprintf("fake2-%d", i)); ok {
			t.Fatal("a made-up one must not be accepted")
		}
	}
	if ok, err := c.Active(ctx, "live"); !ok || err != nil {
		t.Fatalf("accepted site lost in the saturation: %v %v", ok, err)
	}
}

func TestAcceptedMapIsBounded(t *testing.T) {
	clk := &testClock{t: time.Unix(1_700_000_000, 0)}
	always := storeFunc(func(context.Context, string) (bool, error) { return true, nil })
	c := NewCached(always, time.Hour).WithStale(time.Hour)
	c.now = clk.now
	for i := range maxCached + 50 {
		clk.add(time.Millisecond)
		_, _ = c.Active(context.Background(), fmt.Sprintf("s-%d", i))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) > maxCached {
		t.Fatalf("accepted = %d, limit %d", len(c.entries), maxCached)
	}
	if _, ok := c.entries[fmt.Sprintf("s-%d", maxCached+49)]; !ok {
		t.Fatal("the newest entry should be in the cache")
	}
}

type storeFunc func(context.Context, string) (bool, error)

func (f storeFunc) Active(ctx context.Context, id string) (bool, error) { return f(ctx, id) }

// Hanging database: the first request waits for the timeout; then the circuit
// opens and the following ones get the stale one immediately, without new
// queries, until the probe after the backoff.
func TestStaleTimeoutAndCircuitBreaker(t *testing.T) {
	c, next, clk := newStale(time.Hour)
	c.timeout = 50 * time.Millisecond
	ctx := context.Background()
	c.Active(ctx, "live")
	base := next.n()
	next.set(true)
	next.setGate(make(chan struct{})) // never opens: the database hangs
	clk.add(5 * time.Minute)

	start := time.Now()
	if ok, err := c.Active(ctx, "live"); !ok || err != nil {
		t.Fatalf("should serve the stale one after the timeout: %v %v", ok, err)
	}
	if d := time.Since(start); d < 40*time.Millisecond || d > 2*time.Second {
		t.Fatalf("waited %v, expected close to the 50ms timeout", d)
	}

	// Circuit open: immediate answer and no new query.
	start = time.Now()
	for range 100 {
		if ok, err := c.Active(ctx, "live"); !ok || err != nil {
			t.Fatalf("open circuit should serve the stale one: %v %v", ok, err)
		}
		if _, err := c.Active(ctx, "never-seen"); err == nil {
			t.Fatal("an unknown one should get the error")
		}
	}
	if d := time.Since(start); d > 40*time.Millisecond {
		t.Fatalf("open circuit took %v", d)
	}
	if got := next.n() - base; got != 1 {
		t.Fatalf("queries = %d, want 1 (the rest came from the circuit)", got)
	}

	// After the backoff, one probe (only one) tests the database, still
	// hanging.
	clk.add(errBackoff)
	for range 20 {
		if ok, _ := c.Active(ctx, "live"); !ok {
			t.Fatal("during the probe the stale one is still valid")
		}
	}
	// The probe expires in 50ms and reopens the circuit.
	deadline := time.Now().Add(2 * time.Second)
	for {
		c.mu.Lock()
		done := !c.probing && c.failUntil.After(clk.now())
		c.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("probe did not finish")
		}
		runtime.Gosched()
	}
	if got := next.n() - base; got != 2 {
		t.Fatalf("queries = %d, want 2 (the first one and one probe)", got)
	}

	// The database comes back: the next probe closes the circuit.
	next.set(false)
	next.setGate(nil)
	clk.add(errBackoff)
	deadline = time.Now().Add(2 * time.Second)
	for {
		c.Active(ctx, "live")
		c.mu.Lock()
		failed := c.failed
		c.mu.Unlock()
		if !failed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("circuit did not close")
		}
		runtime.Gosched()
	}
	if ok, err := c.Active(ctx, "live"); !ok || err != nil {
		t.Fatalf("after the recovery: %v %v", ok, err)
	}
}
