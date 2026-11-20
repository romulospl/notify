package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/romulospl/stellytics/services/ingest-web/internal/clientip"
	"github.com/romulospl/stellytics/services/ingest-web/internal/fingerprint"
	"github.com/romulospl/stellytics/services/ingest-web/internal/limit"
	"github.com/romulospl/stellytics/services/ingest-web/internal/proof"
	"github.com/romulospl/stellytics/services/ingest-web/internal/relay"
	"github.com/romulospl/stellytics/services/ingest-web/internal/site"
)

const (
	activeSite  = "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab"
	pendingSite = "0a0b0c0d-0e0f-4000-8000-000000000001"
	browserUA   = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

type fakeSites map[string]bool

func (f fakeSites) Active(_ context.Context, id string) (bool, error) { return f[id], nil }

// fakeUmami records what arrives at /api/send.
type fakeUmami struct {
	mu   sync.Mutex
	reqs []received
}

type received struct {
	header http.Header
	body   map[string]any
}

func (u *fakeUmami) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/api/send" {
		http.NotFound(w, r)
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	u.mu.Lock()
	u.reqs = append(u.reqs, received{header: r.Header.Clone(), body: body})
	u.mu.Unlock()
	_, _ = w.Write([]byte(`{"cache":"x"}`))
}

func (u *fakeUmami) received() []received {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]received(nil), u.reqs...)
}

type setup struct {
	gw     *gateway
	umami  *fakeUmami
	server *httptest.Server
}

func newSetup(t *testing.T, opts ...func(*gateway)) setup {
	t.Helper()
	umami := &fakeUmami{}
	us := httptest.NewServer(umami)
	t.Cleanup(us.Close)
	base, _ := url.Parse(us.URL)

	gw := &gateway{
		sites:  fakeSites{activeSite: true, pendingSite: false},
		relay:  relay.NewClient(base, "x-stellytics-client-ip", us.Client()),
		limits: limit.New(1000, 1000, time.Minute),
		ips:    clientip.Resolver{},
		proofs: testProofs,
		fps:    fingerprint.New(1000, 10*time.Minute),
		log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, o := range opts {
		o(gw)
	}
	srv := httptest.NewServer(gw.routes())
	t.Cleanup(srv.Close)
	return setup{gw: gw, umami: umami, server: srv}
}

// testProofs issues the challenges in the tests, with low difficulty.
var testProofs = proof.New([]byte("test-key-with-at-least-32-bytes-long"), 10*time.Minute, 4)

// proofField is the "p" field with a valid proof for website, as the script
// sends it after solving the GET /c challenge.
func proofField(website string) string {
	c := testProofs.Challenge(strings.ToLower(website))
	return `"p":{"t":"` + c.Token + `","n":"` + proof.Solve(c.Token, c.Bits) + `"}`
}

func eventBody(website string) string {
	return `{"type":"event",` + proofField(website) + `,"payload":{"website":"` + website + `","hostname":"example.org",` +
		`"url":"/docs?x=1","referrer":"https://ref.example/","title":"Docs","language":"de-DE","screen":"1920x1080"}}`
}

func post(t *testing.T, s setup, contentType, body string, hdr ...string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, s.server.URL+"/e", strings.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("User-Agent", browserUA)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestEventRelayedToUmami(t *testing.T) {
	for _, ct := range []string{"text/plain;charset=UTF-8", "application/json"} {
		t.Run(ct, func(t *testing.T) {
			s := newSetup(t)
			resp := post(t, s, ct, eventBody(strings.ToUpper(activeSite)))
			if resp.StatusCode != http.StatusNoContent {
				t.Fatalf("status = %d, want 204", resp.StatusCode)
			}
			if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin = %q", got)
			}
			if c := resp.Header.Get("Set-Cookie"); c != "" {
				t.Errorf("response sets a cookie: %q", c)
			}

			got := s.umami.received()
			if len(got) != 1 {
				t.Fatalf("umami received %d events, want 1", len(got))
			}
			h := got[0].header
			if ua := h.Get("User-Agent"); ua != browserUA {
				t.Errorf("relayed User-Agent = %q", ua)
			}
			// httptest connects through 127.0.0.1.
			if ip := h.Get("x-stellytics-client-ip"); ip != "127.0.0.0" {
				t.Errorf("relayed IP = %q, want 127.0.0.0", ip)
			}
			payload := got[0].body["payload"].(map[string]any)
			if payload["website"] != activeSite {
				t.Errorf("website = %v", payload["website"])
			}
		})
	}
}

func TestEventDropsFieldsOutsideAllowlist(t *testing.T) {
	s := newSetup(t)
	body := `{"type":"event","extra":1,` + proofField(activeSite) + `,"payload":{"website":"` + activeSite + `","url":"/",` +
		`"id":"user-42","ip":"203.0.113.77","userAgent":"curl","timestamp":1,` +
		`"browser":"x","os":"y","device":"z","tag":"t"}}`
	if resp := post(t, s, "text/plain", body); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	got := s.umami.received()[0].body
	want := map[string]any{"type": "event", "payload": map[string]any{"website": activeSite, "url": "/"}}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("relayed payload = %s\nquero %s", gotJSON, wantJSON)
	}
}

func TestCustomEventForwardsOnlyNameAndData(t *testing.T) {
	s := newSetup(t)
	body := `{"type":"event",` + proofField(activeSite) + `,"payload":{"website":"` + activeSite + `","url":"/","name":"wallet_connected",` +
		`"data":{"wallet":"freighter","n":3,"ok":true},"id":"user-42","ip":"203.0.113.77","timestamp":1}}`
	if resp := post(t, s, "text/plain", body); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	got, _ := json.Marshal(s.umami.received()[0].body)
	want := `{"payload":{"data":{"n":3,"ok":true,"wallet":"freighter"},"name":"wallet_connected","url":"/","website":"` + activeSite + `"},"type":"event"}`
	if string(got) != want {
		t.Errorf("relayed payload = %s\nquero %s", got, want)
	}
}

func TestCustomEventLimitsAccepted(t *testing.T) {
	s := newSetup(t)
	body := `{"type":"event",` + proofField(activeSite) + `,"payload":{"website":"` + activeSite + `","url":"/","name":"x","data":{"` +
		strings.Repeat("k", relay.MaxDataKey) + `":"` + strings.Repeat("a", relay.MaxDataString) + `"}}}`
	if resp := post(t, s, "text/plain", body); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	if n := len(s.umami.received()); n != 1 {
		t.Fatalf("umami received %d events, want 1", n)
	}
}

func TestCustomEventRejected(t *testing.T) {
	long := strings.Repeat("a", relay.MaxDataString+1)
	many := `{"k0":1`
	for i := 1; i <= relay.MaxDataKeys; i++ {
		many += `,"k` + strings.Repeat("x", i) + `":1`
	}
	many += `}`
	for name, extra := range map[string]string{
		"name with a space":   `"name":"a b"`,
		"long name":           `"name":"` + strings.Repeat("a", relay.MaxName+1) + `"`,
		"name with a symbol":  `"name":"<script>"`,
		"data without a name": `"data":{"a":1}`,
		"nested value":        `"name":"x","data":{"a":{"b":1}}`,
		"list value":          `"name":"x","data":{"a":[1]}`,
		"null value":          `"name":"x","data":{"a":null}`,
		"__proto__":           `"name":"x","data":{"__proto__":1}`,
		"key of 41":           `"name":"x","data":{"` + strings.Repeat("k", relay.MaxDataKey+1) + `":1}`,
		"value of 101":        `"name":"x","data":{"a":"` + strings.Repeat("a", relay.MaxDataString+1) + `"}`,
		"number 1e999":        `"name":"x","data":{"a":1e999}`,
		"huge number":         `"name":"x","data":{"a":` + strings.Repeat("9", 200) + `}`,
		"long value":          `"name":"x","data":{"a":"` + long + `"}`,
		"invalid key":         `"name":"x","data":{"a b":1}`,
		"too many properties": `"name":"x","data":` + many,
	} {
		t.Run(name, func(t *testing.T) {
			s := newSetup(t)
			body := `{"type":"event",` + proofField(activeSite) + `,"payload":{"website":"` + activeSite + `","url":"/",` + extra + `}}`
			if resp := post(t, s, "text/plain", body); resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", resp.StatusCode)
			}
			if n := len(s.umami.received()); n != 0 {
				t.Errorf("umami received %d events", n)
			}
		})
	}
}

func TestEventDoesNotForwardClientHeaders(t *testing.T) {
	s := newSetup(t)
	post(t, s, "text/plain", eventBody(activeSite),
		"X-Forwarded-For", "203.0.113.77", "Cookie", "a=b", "X-Umami-Cache", "token", "Referer", "https://x/")
	h := s.umami.received()[0].header
	for _, k := range []string{"X-Forwarded-For", "Cookie", "X-Umami-Cache", "Referer"} {
		if v := h.Get(k); v != "" {
			t.Errorf("header %s relayed: %q", k, v)
		}
	}
	// Without a trusted proxy, X-Forwarded-For is ignored.
	if ip := h.Get("x-stellytics-client-ip"); ip != "127.0.0.0" {
		t.Errorf("relayed IP = %q", ip)
	}
}

func TestEventTrustedProxyTruncatesForwardedIP(t *testing.T) {
	s := newSetup(t, func(g *gateway) {
		g.ips = clientip.Resolver{Trusted: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}}
	})
	post(t, s, "text/plain", eventBody(activeSite), "X-Forwarded-For", "203.0.113.77")
	if ip := s.umami.received()[0].header.Get("x-stellytics-client-ip"); ip != "203.0.113.0" {
		t.Errorf("relayed IP = %q, want 203.0.113.0", ip)
	}
}

func TestEventRejected(t *testing.T) {
	cases := []struct {
		name, ct, body string
		want           int
	}{
		{"unknown site", "text/plain", eventBody("11111111-2222-4333-8444-555555555555"), http.StatusNoContent},
		{"pending site", "text/plain", eventBody(pendingSite), http.StatusNoContent},
		{"website outside the format", "text/plain", eventBody("not-a-uuid"), http.StatusBadRequest},
		{"different type", "text/plain", `{"type":"identify","payload":{"website":"` + activeSite + `","url":"/"}}`, http.StatusBadRequest},
		{"no url", "text/plain", `{"type":"event","payload":{"website":"` + activeSite + `"}}`, http.StatusBadRequest},
		{"large title", "text/plain", `{"type":"event","payload":{"website":"` + activeSite + `","url":"/","title":"` + strings.Repeat("a", relay.MaxTitle+1) + `"}}`, http.StatusBadRequest},
		{"invalid JSON", "text/plain", `{"type":`, http.StatusBadRequest},
		{"two objects", "text/plain", eventBody(activeSite) + eventBody(activeSite), http.StatusBadRequest},
		{"content-type", "application/x-www-form-urlencoded", eventBody(activeSite), http.StatusUnsupportedMediaType},
		{"large body", "text/plain", `{"type":"event","payload":{"website":"` + activeSite + `","url":"/` + strings.Repeat("a", maxBody) + `"}}`, http.StatusRequestEntityTooLarge},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newSetup(t)
			resp := post(t, s, c.ct, c.body)
			if resp.StatusCode != c.want {
				t.Errorf("status = %d, want %d", resp.StatusCode, c.want)
			}
			if n := len(s.umami.received()); n != 0 {
				t.Errorf("umami received %d events, want 0", n)
			}
		})
	}
}

func TestEventRateLimited(t *testing.T) {
	s := newSetup(t, func(g *gateway) { g.limits = limit.New(0.001, 2, time.Minute) })
	var codes []int
	for range 3 {
		codes = append(codes, post(t, s, "text/plain", eventBody(activeSite)).StatusCode)
	}
	want := []int{204, 204, 429}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("status = %v, want %v", codes, want)
		}
	}
	if n := len(s.umami.received()); n != 2 {
		t.Errorf("umami received %d events, want 2", n)
	}
}

func TestEventUmamiFailure(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	t.Cleanup(down.Close)
	base, _ := url.Parse(down.URL)
	s := newSetup(t, func(g *gateway) { g.relay = relay.NewClient(base, "x-stellytics-client-ip", down.Client()) })
	if resp := post(t, s, "text/plain", eventBody(activeSite)); resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", resp.StatusCode)
	}
}

func TestPreflight(t *testing.T) {
	s := newSetup(t)
	req, _ := http.NewRequest(http.MethodOptions, s.server.URL+"/e", nil)
	req.Header.Set("Origin", "https://site.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent ||
		resp.Header.Get("Access-Control-Allow-Origin") != "*" ||
		resp.Header.Get("Access-Control-Allow-Methods") != "POST" {
		t.Errorf("preflight = %d %v", resp.StatusCode, resp.Header)
	}
}

func TestHealthz(t *testing.T) {
	s := newSetup(t)
	resp, err := http.Get(s.server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d", resp.StatusCode)
	}
	if code := checkHealth(s.server.Listener.Addr().String()); code != 0 {
		t.Errorf("checkHealth = %d, want 0", code)
	}
}

func TestScripts(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "v1.0.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "v1.0.0", "n.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	s := newSetup(t, func(g *gateway) { g.scripts = root })

	resp, err := http.Get(s.server.URL + "/s/v1.0.0/n.js")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "console.log(1)" {
		t.Fatalf("status = %d, body = %q", resp.StatusCode, body)
	}
	for k, want := range map[string]string{
		"Cache-Control":               "public, max-age=31536000, immutable",
		"Access-Control-Allow-Origin": "*",
		"Content-Type":                "text/javascript; charset=utf-8",
		"X-Content-Type-Options":      "nosniff",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}

	for _, p := range []string{"/s/", "/s/v1.0.0/", "/s/v9.9.9/n.js", "/s/../secret.txt", "/s/%2e%2e/secret.txt"} {
		resp, err := http.Get(s.server.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, resp.StatusCode)
		}
		if cc := resp.Header.Get("Cache-Control"); strings.Contains(cc, "immutable") {
			t.Errorf("%s: 404 with immutable cache", p)
		}
	}
}

// With SITE_STALE_TTL at 0, nothing stale is served: the database failure still
// becomes 503, even for a site the cache has already known.
func TestEventStaleOffReturns503OnDBFailure(t *testing.T) {
	var fail atomic.Bool
	store := siteFunc(func(_ context.Context, id string) (bool, error) {
		if fail.Load() {
			return false, context.DeadlineExceeded
		}
		return id == activeSite, nil
	})
	// TTL 0: every request queries the database; without stale, the error goes
	// through.
	s := newSetup(t, func(g *gateway) { g.sites = site.NewCached(store, 0).WithStale(0) })
	if r := post(t, s, "text/plain", eventBody(activeSite)); r.StatusCode != http.StatusNoContent {
		t.Fatalf("database ok: status = %d, want 204", r.StatusCode)
	}
	fail.Store(true)
	if r := post(t, s, "text/plain", eventBody(activeSite)); r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("database down, stale off: status = %d, want 503", r.StatusCode)
	}
	if n := len(s.umami.received()); n != 1 {
		t.Fatalf("relayed events = %d, want 1", n)
	}
}

// With stale on, the same known site stays accepted; an unknown one does not.
func TestEventStaleOnServesKnownSite(t *testing.T) {
	var fail atomic.Bool
	store := siteFunc(func(_ context.Context, id string) (bool, error) {
		if fail.Load() {
			return false, context.DeadlineExceeded
		}
		return id == activeSite, nil
	})
	s := newSetup(t, func(g *gateway) { g.sites = site.NewCached(store, 0).WithStale(time.Hour) })
	post(t, s, "text/plain", eventBody(activeSite))
	fail.Store(true)
	if r := post(t, s, "text/plain", eventBody(activeSite)); r.StatusCode != http.StatusNoContent {
		t.Fatalf("known with database down: status = %d, want 204", r.StatusCode)
	}
	if n := len(s.umami.received()); n != 2 {
		t.Fatalf("relayed events = %d, want 2", n)
	}
	unknown := "0a0b0c0d-0e0f-4000-8000-0000000000ff"
	if r := post(t, s, "text/plain", eventBody(unknown)); r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unknown with database down: status = %d, want 503", r.StatusCode)
	}
}

type siteFunc func(context.Context, string) (bool, error)

func (f siteFunc) Active(ctx context.Context, id string) (bool, error) { return f(ctx, id) }

// logStale logs the total of stale answers, without identifiers.
func TestLogStaleReportsCount(t *testing.T) {
	var fail atomic.Bool
	store := siteFunc(func(context.Context, string) (bool, error) {
		if fail.Load() {
			return false, context.DeadlineExceeded
		}
		return true, nil
	})
	sites := site.NewCached(store, 0).WithStale(time.Hour)
	sites.Active(context.Background(), activeSite)
	fail.Store(true)
	sites.Active(context.Background(), activeSite)

	var buf syncBuffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { logStale(ctx, log, sites, 10*time.Millisecond); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(buf.String(), "stale") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	out := buf.String()
	if !strings.Contains(out, `"responses":1`) || !strings.Contains(out, `"total":1`) {
		t.Fatalf("unexpected log: %s", out)
	}
	if strings.Contains(out, activeSite) {
		t.Fatal("the log must not contain the site ID")
	}
}
