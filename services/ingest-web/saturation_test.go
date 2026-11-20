package main

// Tests for the limit on concurrent relays to Umami (RELAY_MAX_INFLIGHT).

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/romulospl/stellytics/services/ingest-web/internal/fingerprint"
	"github.com/romulospl/stellytics/services/ingest-web/internal/relay"
)

// slowUmami holds each /api/send until release is closed.
type slowUmami struct {
	release chan struct{}
	once    sync.Once
	started atomic.Int64
	cur     atomic.Int64
	peak    atomic.Int64
}

func newSlowUmami(t *testing.T) (*slowUmami, relay.Sender) {
	t.Helper()
	u := &slowUmami{release: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.started.Add(1)
		n := u.cur.Add(1)
		for {
			p := u.peak.Load()
			if n <= p || u.peak.CompareAndSwap(p, n) {
				break
			}
		}
		defer u.cur.Add(-1)
		select {
		case <-u.release:
		case <-r.Context().Done():
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	base, _ := url.Parse(srv.URL)
	return u, relay.NewClient(base, "x-stellytics-client-ip", srv.Client())
}

func (u *slowUmami) open() {
	u.once.Do(func() { close(u.release) })
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func postAsync(s setup, body string, ua string) <-chan *http.Response {
	ch := make(chan *http.Response, 1)
	go func() {
		req, _ := http.NewRequest(http.MethodPost, s.server.URL+"/e", strings.NewReader(body))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set("User-Agent", ua)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			ch <- nil
			return
		}
		resp.Body.Close()
		ch <- resp
	}()
	return ch
}

func TestSaturationReturns204AndKeepsOtherRoutes(t *testing.T) {
	umami, inner := newSlowUmami(t)
	limited := relay.NewLimited(inner, 3, 20*time.Millisecond)
	s := newSetup(t, func(g *gateway) { g.relay = limited })
	t.Cleanup(umami.open) // runs before the gateway's Close, so that a failure does not hang

	a := postAsync(s, eventBody(activeSite), "ua-a")
	b := postAsync(s, eventBody(activeSite), "ua-b")
	waitFor(t, func() bool { return umami.started.Load() == 2 })

	resp := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-c")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	if resp.Header.Get("Retry-After") != "" {
		t.Error("unexpected Retry-After")
	}
	if limited.Dropped() != 1 || umami.started.Load() != 2 {
		t.Errorf("dropped = %d, umami received %d", limited.Dropped(), umami.started.Load())
	}

	// The limit applies only to the relay: an invalid proof, /c, /healthz and a
	// refused site answer as always, even with the relay saturated.
	bad := strings.Replace(eventBody(activeSite), `"n":"`, `"n":"x`, 1)
	if r := post(t, s, "text/plain", bad); r.StatusCode != http.StatusNoContent {
		t.Errorf("invalid proof: %d", r.StatusCode)
	}
	if r := post(t, s, "text/plain", eventBody(pendingSite)); r.StatusCode != http.StatusNoContent {
		t.Errorf("refused site: %d", r.StatusCode)
	}
	for _, p := range []string{"/c?s=" + activeSite, "/healthz"} {
		r, err := http.Get(s.server.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Errorf("%s: %d", p, r.StatusCode)
		}
	}
	if limited.Dropped() != 1 {
		t.Errorf("dropped = %d, want 1 (the other routes do not count)", limited.Dropped())
	}

	umami.open()
	for _, ch := range []<-chan *http.Response{a, b} {
		if r := <-ch; r == nil || r.StatusCode != http.StatusNoContent {
			t.Fatalf("accepted ones should give 204: %v", r)
		}
	}
	// Free again.
	if r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-d"); r.StatusCode != http.StatusNoContent {
		t.Fatalf("after saturation: %d", r.StatusCode)
	}
}

// The response does not tell a fingerprint already admitted from a new one that
// exceeds the quota, even with all the relay slots taken.
func TestSaturationHidesFingerprintQuota(t *testing.T) {
	umami, inner := newSlowUmami(t)
	limited := relay.NewLimited(inner, 1, 10*time.Millisecond)
	s := newSetup(t, func(g *gateway) {
		g.relay = limited
		g.fps = fingerprint.New(1, 10*time.Minute)
	})
	t.Cleanup(umami.open)
	postAsync(s, eventBody(activeSite), "ua-hold")
	waitFor(t, func() bool { return umami.started.Load() == 1 })
	admitted := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-hold")
	if admitted.StatusCode != http.StatusNoContent || limited.Dropped() != 1 {
		t.Fatalf("admitted fingerprint: status %d, drops %d", admitted.StatusCode, limited.Dropped())
	}
	full := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-new")
	if full.StatusCode != admitted.StatusCode || full.Header.Get("Retry-After") != admitted.Header.Get("Retry-After") {
		t.Fatalf("different responses: admitted %d, quota full %d", admitted.StatusCode, full.StatusCode)
	}
	if limited.Dropped() != 1 || umami.started.Load() != 1 {
		t.Fatalf("a full quota should prevent the relay: drops %d, relays %d", limited.Dropped(), umami.started.Load())
	}
}

// An event dropped because of saturation does not spend the IP's fingerprint
// quota: with limit 1, after being refused it can be resent and the fingerprint
// still fits; a second, different one is only refused by the quota when the
// first one really went through.
func TestSaturationDoesNotConsumeFingerprintQuota(t *testing.T) {
	umami, inner := newSlowUmami(t)
	limited := relay.NewLimited(inner, 1, 10*time.Millisecond)
	s := newSetup(t, func(g *gateway) {
		g.relay = limited
		g.fps = fingerprint.New(3, 10*time.Minute)
	})
	t.Cleanup(umami.open)
	// Takes the only slot (counts as 1 of the IP's 3 fingerprints).
	postAsync(s, eventBody(activeSite), "ua-hold")
	waitFor(t, func() bool { return umami.started.Load() == 1 })
	// Same IP: three new fingerprints, all refused because of saturation. If
	// each one spent the quota (limit 3, with the hold one), the third would
	// hit the quota (204).
	for _, ua := range []string{"ua-1", "ua-2", "ua-3"} {
		r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", ua)
		if r.StatusCode != http.StatusNoContent {
			t.Fatalf("%s: status = %d, want 204", ua, r.StatusCode)
		}
	}
	umami.open()
	waitFor(t, func() bool { return limited.InFlight() == 0 })
	// Now there is a slot: the rejected fingerprints still fit in the quota.
	for _, ua := range []string{"ua-1", "ua-2"} {
		if r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", ua); r.StatusCode != http.StatusNoContent {
			t.Fatalf("%s: %d", ua, r.StatusCode)
		}
	}
	if n := umami.started.Load(); n != 3 {
		t.Fatalf("umami received %d, want 3", n)
	}
}

// Without RELAY_MAX_INFLIGHT (relay without the limiter), the behaviour is the
// same as before: 30 slow relays run together, none is refused.
func TestNoLimitKeepsUnboundedRelay(t *testing.T) {
	umami, inner := newSlowUmami(t)
	s := newSetup(t, func(g *gateway) { g.relay = inner })
	t.Cleanup(umami.open)
	var chans []<-chan *http.Response
	for i := range 30 {
		chans = append(chans, postAsync(s, eventBody(activeSite), "ua-"+string(rune('a'+i))))
	}
	waitFor(t, func() bool { return umami.started.Load() == 30 })
	if umami.peak.Load() != 30 {
		t.Errorf("peak = %d, want 30 (no limit)", umami.peak.Load())
	}
	umami.open()
	for _, ch := range chans {
		if r := <-ch; r == nil || r.StatusCode != http.StatusNoContent {
			t.Fatalf("response %v", r)
		}
	}
}

func TestPanicInRelayFreesSlot(t *testing.T) {
	var boom atomic.Bool
	boom.Store(true)
	inner := panicSender(func() error {
		if boom.Load() {
			panic("boom")
		}
		return nil
	})
	limited := relay.NewLimited(inner, 1, 10*time.Millisecond)
	s := newSetup(t, func(g *gateway) { g.relay = limited })
	if r := post(t, s, "text/plain", eventBody(activeSite)); r.StatusCode != http.StatusInternalServerError {
		t.Fatalf("panic: %d", r.StatusCode)
	}
	boom.Store(false)
	if r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "other"); r.StatusCode != http.StatusNoContent {
		t.Fatalf("after the panic: %d (slot stuck?)", r.StatusCode)
	}
}

type panicSender func() error

func (f panicSender) Send(context.Context, relay.Event, string, netip.Addr) error { return f() }

func TestLogSaturatedReportsCountOnlyOnChange(t *testing.T) {
	g := newSlowGate()
	limited := relay.NewLimited(g, 1, 0)
	go func() { _ = limited.Send(context.Background(), relay.Event{}, "ua", netip.Addr{}) }()
	<-g.in
	_ = limited.Send(context.Background(), relay.Event{Payload: relay.Payload{Website: activeSite}}, "Mozilla-secret", netip.MustParseAddr("203.0.113.9"))

	var buf syncBuffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { logSaturated(ctx, log, limited, 10*time.Millisecond); close(done) }()
	waitFor(t, func() bool { return strings.Contains(buf.String(), "saturated") })
	time.Sleep(60 * time.Millisecond) // several ticks with no change: no new line
	cancel()
	<-done
	out := buf.String()
	if strings.Count(out, "saturated") != 1 {
		t.Fatalf("expected a single line: %s", out)
	}
	if !strings.Contains(out, `"dropped":1`) || !strings.Contains(out, `"total":1`) {
		t.Fatalf("unexpected log: %s", out)
	}
	for _, secret := range []string{activeSite, "Mozilla-secret", "203.0.113.9"} {
		if strings.Contains(out, secret) {
			t.Fatalf("the log must not contain %q", secret)
		}
	}
	close(g.out)
}

type slowGate struct {
	in  chan struct{}
	out chan struct{}
}

func newSlowGate() *slowGate { return &slowGate{in: make(chan struct{}, 1), out: make(chan struct{})} }

func (g *slowGate) Send(ctx context.Context, _ relay.Event, _ string, _ netip.Addr) error {
	g.in <- struct{}{}
	select {
	case <-g.out:
	case <-ctx.Done():
	}
	return nil
}

// A client that cancels while waiting for the slot produces no error log and
// does not count as a drop, and its new fingerprint goes back to the quota.
func TestClientCancelWhileWaitingForSlot(t *testing.T) {
	umami, inner := newSlowUmami(t)
	limited := relay.NewLimited(inner, 1, 5*time.Second)
	var buf syncBuffer
	s := newSetup(t, func(g *gateway) {
		g.relay = limited
		g.fps = fingerprint.New(2, 10*time.Minute)
		g.log = slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	t.Cleanup(umami.open)
	postAsync(s, eventBody(activeSite), "ua-hold")
	waitFor(t, func() bool { return umami.started.Load() == 1 })

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.server.URL+"/e", strings.NewReader(eventBody(activeSite)))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("User-Agent", "ua-cancel")
	done := make(chan struct{})
	go func() {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
		close(done)
	}()
	waitFor(t, func() bool { return limited.InFlight() == 1 })
	time.Sleep(50 * time.Millisecond) // the handler is already waiting for the slot
	cancel()
	<-done
	waitFor(t, func() bool { return strings.Contains(buf.String(), "client cancelled") })

	if strings.Contains(buf.String(), `"level":"ERROR"`) {
		t.Errorf("cancellation is not an error: %s", buf.String())
	}
	if limited.Dropped() != 0 {
		t.Errorf("dropped = %d", limited.Dropped())
	}
	// The quota (2) holds the hold fingerprint; the cancelled one's was
	// returned, so a third still fits and reaches Umami.
	umami.open()
	waitFor(t, func() bool { return limited.InFlight() == 0 })
	if r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-other"); r.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", r.StatusCode)
	}
	if n := umami.started.Load(); n != 2 {
		t.Fatalf("umami received %d, want 2 (hold and ua-other)", n)
	}
}

// A panic in the relay also returns the new fingerprint.
func TestPanicInRelayReturnsFingerprint(t *testing.T) {
	var boom atomic.Bool
	boom.Store(true)
	var sent atomic.Int64
	inner := panicSender(func() error {
		if boom.Load() {
			panic("boom")
		}
		sent.Add(1)
		return nil
	})
	s := newSetup(t, func(g *gateway) {
		g.relay = inner
		g.fps = fingerprint.New(1, 10*time.Minute)
	})
	if r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-1"); r.StatusCode != http.StatusInternalServerError {
		t.Fatalf("panic: %d", r.StatusCode)
	}
	boom.Store(false)
	// Limit 1: if ua-1 still occupied the count, ua-2 would be dropped (204
	// without a relay).
	if r := post(t, s, "text/plain", eventBody(activeSite), "User-Agent", "ua-2"); r.StatusCode != http.StatusNoContent || sent.Load() != 1 {
		t.Fatalf("status = %d, relayed = %d", r.StatusCode, sent.Load())
	}
}

// On shutdown, the last partial minute is still logged.
func TestLogSaturatedFlushesOnShutdown(t *testing.T) {
	g := newSlowGate()
	limited := relay.NewLimited(g, 1, 0)
	go func() { _ = limited.Send(context.Background(), relay.Event{}, "ua", netip.Addr{}) }()
	<-g.in
	_ = limited.Send(context.Background(), relay.Event{}, "ua", netip.Addr{})
	var buf syncBuffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	logSaturated(ctx, log, limited, time.Hour) // returns immediately, without any tick
	if !strings.Contains(buf.String(), `"dropped":1`) {
		t.Fatalf("no final line: %q", buf.String())
	}
	close(g.out)
}
