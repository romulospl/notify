package main

// Test for #26: many fingerprints on the same truncated IP do not inflate the
// metrics.

import (
	"net/http"
	"net/netip"
	"testing"
	"time"

	"github.com/romulospl/stellytics/services/ingest-web/internal/clientip"
	"github.com/romulospl/stellytics/services/ingest-web/internal/fingerprint"
)

// otherActiveSite is another tenant's site, also active.
const otherActiveSite = "11111111-2222-4333-8444-555555555555"

func TestFingerprintLimitPerIP(t *testing.T) {
	s := newSetup(t, func(g *gateway) {
		g.fps = fingerprint.New(2, 10*time.Minute)
		g.sites = fakeSites{activeSite: true, otherActiveSite: true}
		g.ips = clientip.Resolver{Trusted: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}}
	})
	send := func(ip, ua string) {
		t.Helper()
		resp := post(t, s, "text/plain", eventBody(activeSite), "X-Forwarded-For", ip, "User-Agent", ua)
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 even when it drops", resp.StatusCode)
		}
	}

	// A bot changes User-Agent on every request in the same /24.
	send("203.0.113.10", "bot/1")
	send("203.0.113.11", "bot/2")
	send("203.0.113.12", "bot/3")
	send("203.0.113.13", "bot/4")
	// The first two fingerprints still count; another IP has its own count.
	send("203.0.113.14", "bot/1")
	send("198.51.100.7", "bot/3")
	// Another site in the same /24 too: the bot does not fill the quota of
	// other tenants.
	resp := post(t, s, "text/plain", eventBody(otherActiveSite), "X-Forwarded-For", "203.0.113.15", "User-Agent", "human")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	var uas []string
	for _, r := range s.umami.received() {
		uas = append(uas, r.header.Get("User-Agent")+" @ "+r.header.Get("x-stellytics-client-ip"))
	}
	want := []string{
		"bot/1 @ 203.0.113.0",
		"bot/2 @ 203.0.113.0",
		"bot/1 @ 203.0.113.0",
		"bot/3 @ 198.51.100.0",
		"human @ 203.0.113.0",
	}
	if len(uas) != len(want) {
		t.Fatalf("umami received %v, want %v", uas, want)
	}
	for i := range want {
		if uas[i] != want[i] {
			t.Errorf("event %d = %q, want %q", i, uas[i], want[i])
		}
	}
}
