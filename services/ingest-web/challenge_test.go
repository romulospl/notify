package main

// Tests for #25: the challenge on GET /c and the dropping of events without a
// proof.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/romulospl/stellytics/services/ingest-web/internal/proof"
)

func TestChallenge(t *testing.T) {
	s := newSetup(t)
	resp, err := http.Get(s.server.URL + "/c?s=" + strings.ToUpper(activeSite))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	for k, want := range map[string]string{
		"Content-Type":                "application/json",
		"Cache-Control":               "no-store",
		"Access-Control-Allow-Origin": "*",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	var c proof.Challenge
	if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
		t.Fatal(err)
	}
	if c.Bits != 4 || c.Token == "" {
		t.Fatalf("challenge = %+v", c)
	}
	if err := testProofs.Verify(activeSite, c.Token, proof.Solve(c.Token, c.Bits)); err != nil {
		t.Errorf("challenge token is not valid for the site: %v", err)
	}

	for _, q := range []string{"", "?s=", "?s=not-a-uuid"} {
		resp, err := http.Get(s.server.URL + "/c" + q)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("/c%s: status = %d, want 400", q, resp.StatusCode)
		}
	}
}

func TestEventWithoutValidProofDiscarded(t *testing.T) {
	// A challenge issued 11 minutes ago with the same key.
	old := proof.New([]byte("test-key-with-at-least-32-bytes-long"), 10*time.Minute, 4).
		WithClock(func() time.Time { return time.Now().Add(-11 * time.Minute) }).
		Challenge(activeSite).Token

	valid := testProofs.Challenge(activeSite)
	payload := `"payload":{"website":"` + activeSite + `","url":"/"}`
	otherSite := testProofs.Challenge(pendingSite)
	bad := "0"
	for proof.Solved(valid.Token, bad, valid.Bits) {
		bad += "1"
	}

	cases := map[string]string{
		// A direct POST, as curl would do.
		"no proof":                `{"type":"event",` + payload + `}`,
		"made-up token":           `{"type":"event","p":{"t":"` + strings.Repeat("A", 43) + `","n":"1"},` + payload + `}`,
		"nonce without work":      `{"type":"event","p":{"t":"` + valid.Token + `","n":"` + bad + `"},` + payload + `}`,
		"token from another site": `{"type":"event","p":{"t":"` + otherSite.Token + `","n":"` + proof.Solve(otherSite.Token, 4) + `"},` + payload + `}`,
		"expired token":           `{"type":"event","p":{"t":"` + old + `","n":"` + proof.Solve(old, 4) + `"},` + payload + `}`,
		"badly formatted proof":   `{"type":"event","p":"abc",` + payload + `}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSetup(t)
			resp := post(t, s, "text/plain", body)
			want := http.StatusNoContent
			if name == "badly formatted proof" {
				want = http.StatusBadRequest
			}
			if resp.StatusCode != want {
				t.Errorf("status = %d, want %d", resp.StatusCode, want)
			}
			if n := len(s.umami.received()); n != 0 {
				t.Errorf("umami received %d events, want 0", n)
			}
		})
	}

	t.Run("valid proof", func(t *testing.T) {
		s := newSetup(t)
		body := `{"type":"event","p":{"t":"` + valid.Token + `","n":"` + proof.Solve(valid.Token, 4) + `"},` + payload + `}`
		if resp := post(t, s, "text/plain", body); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		got := s.umami.received()
		if len(got) != 1 {
			t.Fatalf("umami received %d events, want 1", len(got))
		}
		if _, ok := got[0].body["p"]; ok {
			t.Error("the proof was relayed to Umami")
		}
	})
}
