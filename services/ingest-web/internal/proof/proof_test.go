package proof

import (
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

const site = "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab"

func newIssuer(now time.Time) *Issuer {
	i := New([]byte("test-key-with-at-least-32-bytes-long"), 10*time.Minute, 8)
	i.now = func() time.Time { return now }
	return i
}

func TestVerify(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	issuer := newIssuer(now)
	c := issuer.Challenge(site)
	if c.Bits != 8 {
		t.Fatalf("Bits = %d", c.Bits)
	}
	nonce := Solve(c.Token, c.Bits)

	if err := issuer.Verify(site, c.Token, nonce); err != nil {
		t.Fatalf("valid proof refused: %v", err)
	}

	// Find a nonce that does not solve it.
	bad := "0"
	for Solved(c.Token, bad, c.Bits) {
		bad += "1"
	}
	other := New([]byte("another-key-with-at-least-32-bytes!!"), 10*time.Minute, 8)
	other.now = issuer.now
	forged := other.Challenge(site)

	raw, _ := base64.RawURLEncoding.DecodeString(c.Token)
	raw[10] ^= 1
	tampered := base64.RawURLEncoding.EncodeToString(raw)

	cases := []struct {
		name                  string
		website, token, nonce string
		want                  error
	}{
		{"no proof", site, "", "", ErrMissing},
		{"no nonce", site, c.Token, "", ErrMalformed},
		{"non-numeric nonce", site, c.Token, "abc", ErrMalformed},
		{"long nonce", site, c.Token, "123456789012345678901", ErrMalformed},
		{"short token", site, "abc", nonce, ErrMalformed},
		{"token from another key", site, forged.Token, Solve(forged.Token, 8), ErrSignature},
		{"tampered token", site, tampered, Solve(tampered, 8), ErrSignature},
		{"another site", "0a0b0c0d-0e0f-4000-8000-000000000001", c.Token, nonce, ErrSignature},
		{"insufficient work", site, c.Token, bad, ErrWork},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := issuer.Verify(tc.website, tc.token, tc.nonce); !errors.Is(err, tc.want) {
				t.Errorf("Verify = %v, want %v", err, tc.want)
			}
		})
	}

	t.Run("uppercase site", func(t *testing.T) {
		if err := issuer.Verify("6F1C2B9E-3A4D-4C8E-9F00-1234567890AB", c.Token, nonce); err != nil {
			t.Errorf("Verify = %v", err)
		}
	})
}

func TestVerifyExpiry(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	c := newIssuer(now).Challenge(site)
	nonce := Solve(c.Token, c.Bits)

	cases := map[string]struct {
		at   time.Time
		want error
	}{
		"within the deadline":  {now.Add(9 * time.Minute), nil},
		"expired":              {now.Add(11 * time.Minute), ErrExpired},
		"issued in the future": {now.Add(-2 * time.Minute), ErrExpired},
		"clock ahead":          {now.Add(-30 * time.Second), nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if err := newIssuer(tc.at).Verify(site, c.Token, nonce); !errors.Is(err, tc.want) {
				t.Errorf("Verify = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestLeadingZeros(t *testing.T) {
	cases := []struct {
		in   []byte
		want int
	}{
		{[]byte{0x80}, 0},
		{[]byte{0x01}, 7},
		{[]byte{0x00, 0x10}, 11},
		{[]byte{0x00, 0x00}, 16},
	}
	for _, c := range cases {
		if got := LeadingZeros(c.in); got != c.want {
			t.Errorf("LeadingZeros(%x) = %d, want %d", c.in, got, c.want)
		}
	}
}
