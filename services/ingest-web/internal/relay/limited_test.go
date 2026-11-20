package relay

import (
	"context"
	"errors"
	"net/netip"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// gate is a Sender that holds each call until it receives a signal.
type gate struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int64
	fn      func()
}

func newGate() *gate {
	return &gate{started: make(chan struct{}, 1000), release: make(chan struct{})}
}

func (g *gate) Send(ctx context.Context, _ Event, _ string, _ netip.Addr) error {
	g.calls.Add(1)
	g.started <- struct{}{}
	if g.fn != nil {
		g.fn()
	}
	select {
	case <-g.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func send(l *Limited, ctx context.Context) error {
	return l.Send(ctx, Event{}, "ua", netip.Addr{})
}

func waitStarted(t *testing.T, g *gate, n int) {
	t.Helper()
	for range n {
		select {
		case <-g.started:
		case <-time.After(2 * time.Second):
			t.Fatal("relay did not start")
		}
	}
}

func TestLimitedCapsInflightAndRefusesAfterWait(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 3, 30*time.Millisecond)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _ = send(l, context.Background()) }()
	}
	waitStarted(t, g, 2)
	if l.InFlight() != 2 {
		t.Fatalf("in flight = %d", l.InFlight())
	}
	start := time.Now()
	err := send(l, context.Background())
	if !errors.Is(err, ErrSaturated) {
		t.Fatalf("err = %v, want ErrSaturated", err)
	}
	if d := time.Since(start); d < 25*time.Millisecond || d > time.Second {
		t.Errorf("waited %v, want about 30ms", d)
	}
	if g.calls.Load() != 2 || l.Dropped() != 1 {
		t.Errorf("calls = %d, dropped = %d", g.calls.Load(), l.Dropped())
	}
	close(g.release)
	wg.Wait()
	if l.InFlight() != 0 {
		t.Errorf("slots not returned: %d", l.InFlight())
	}
}

func TestLimitedWaiterGetsFreedSlot(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 1, 2*time.Second)
	first := make(chan error, 1)
	go func() { first <- send(l, context.Background()) }()
	waitStarted(t, g, 1)
	second := make(chan error, 1)
	go func() { second <- send(l, context.Background()) }()
	time.Sleep(20 * time.Millisecond) // the second one is waiting for the slot
	g.release <- struct{}{}           // releases the first one
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	waitStarted(t, g, 1) // the second one took the slot
	g.release <- struct{}{}
	if err := <-second; err != nil {
		t.Fatalf("the one that waited should go through: %v", err)
	}
	if l.Dropped() != 0 {
		t.Errorf("dropped = %d", l.Dropped())
	}
}

func TestLimitedZeroWaitRefusesImmediately(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 1, 0)
	go func() { _ = send(l, context.Background()) }()
	waitStarted(t, g, 1)
	if err := send(l, context.Background()); !errors.Is(err, ErrSaturated) {
		t.Fatalf("err = %v", err)
	}
	close(g.release)
}

func TestLimitedReleasesOnPanic(t *testing.T) {
	g := newGate()
	g.fn = func() { panic("boom") }
	l := NewLimited(g, 1, 10*time.Millisecond)
	func() {
		defer func() {
			if recover() == nil {
				t.Error("the panic should go through")
			}
		}()
		_ = send(l, context.Background())
	}()
	if l.InFlight() != 0 {
		t.Fatalf("slot stuck after the panic: %d", l.InFlight())
	}
	g.fn = nil
	close(g.release)
	if err := send(l, context.Background()); err != nil {
		t.Fatalf("after the panic: %v", err)
	}
}

func TestLimitedReleasesOnErrorAndCancel(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 1, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- send(l, ctx) }()
	waitStarted(t, g, 1)
	cancel() // the client gave up in the middle of the relay
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if l.InFlight() != 0 {
		t.Fatalf("slot stuck after the cancellation: %d", l.InFlight())
	}
}

func TestLimitedCancelWhileWaitingIsNotCountedAsDrop(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 1, 5*time.Second)
	go func() { _ = send(l, context.Background()) }()
	waitStarted(t, g, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- send(l, ctx) }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if l.Dropped() != 0 || g.calls.Load() != 1 {
		t.Errorf("dropped = %d, calls = %d", l.Dropped(), g.calls.Load())
	}
	close(g.release)
}

// Many arrivals at the same time: it never goes past max in flight, everything
// is accepted or refused, nothing is left hanging and no goroutine leaks.
func TestLimitedConcurrentNoLeak(t *testing.T) {
	before := runtime.NumGoroutine()
	var cur, peak, ok, refused atomic.Int64
	inner := senderFunc(func(ctx context.Context) error {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		cur.Add(-1)
		return nil
	})
	l := NewLimited(inner, 4, 3*time.Millisecond)
	var wg sync.WaitGroup
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch err := send(l, context.Background()); {
			case err == nil:
				ok.Add(1)
			case errors.Is(err, ErrSaturated):
				refused.Add(1)
			default:
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if peak.Load() > 4 {
		t.Errorf("peak in flight = %d, limit 4", peak.Load())
	}
	if ok.Load()+refused.Load() != 200 || refused.Load() != int64(l.Dropped()) || refused.Load() == 0 || ok.Load() == 0 {
		t.Errorf("accepted %d, refused %d, counter %d", ok.Load(), refused.Load(), l.Dropped())
	}
	if l.InFlight() != 0 {
		t.Errorf("in flight at the end = %d", l.InFlight())
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > before {
		t.Errorf("goroutines: %d before, %d after", before, n)
	}
}

type senderFunc func(ctx context.Context) error

func (f senderFunc) Send(ctx context.Context, _ Event, _ string, _ netip.Addr) error { return f(ctx) }

func TestLimitedReservesSlotForAnotherSite(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 3, 0)
	event := func(site string) Event { return Event{Payload: Payload{Website: site}} }
	for range 2 {
		go func() { _ = l.Send(context.Background(), event("a"), "", netip.Addr{}) }()
	}
	waitStarted(t, g, 2)
	if err := l.Send(context.Background(), event("a"), "", netip.Addr{}); !errors.Is(err, ErrSaturated) {
		t.Fatalf("site at peak: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- l.Send(context.Background(), event("b"), "", netip.Addr{}) }()
	waitStarted(t, g, 1)
	if l.InFlight() != 3 {
		t.Fatalf("in flight: %d", l.InFlight())
	}
	close(g.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestLimitedDoesNotRetainRejectedSites(t *testing.T) {
	g := newGate()
	l := NewLimited(g, 2, 0)
	for _, site := range []string{"a", "b"} {
		go func() { _ = l.Send(context.Background(), Event{Payload: Payload{Website: site}}, "", netip.Addr{}) }()
	}
	waitStarted(t, g, 2)
	for i := 0; i < 10000; i++ {
		err := l.Send(context.Background(), Event{Payload: Payload{Website: strconv.Itoa(i)}}, "", netip.Addr{})
		if !errors.Is(err, ErrSaturated) {
			t.Fatalf("site %d: %v", i, err)
		}
	}
	l.mu.Lock()
	n := len(l.bySite)
	l.mu.Unlock()
	if n != 2 {
		t.Fatalf("sites in memory = %d", n)
	}
	close(g.release)
}
