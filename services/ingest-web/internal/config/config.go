// Package config reads the gateway configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Config gathers everything the gateway needs to start.
type Config struct {
	// ListenAddr is the gateway's HTTP address (e.g. ":8080").
	ListenAddr string
	// DatabaseURL points to the stellytics database with the stellytics_ingest
	// user.
	DatabaseURL string
	// UmamiURL is the Umami base URL on the internal network (e.g.
	// "http://umami:3000").
	UmamiURL *url.URL
	// ClientIPHeader is the header in which the truncated IP reaches Umami.
	ClientIPHeader string
	// ScriptDir is the directory served at /s/. Empty turns the route off.
	ScriptDir string
	// TrustedProxies are the networks from which X-Forwarded-For is accepted.
	TrustedProxies []netip.Prefix
	// RateLimit and RateBurst define the token bucket per truncated IP.
	RateLimit float64
	RateBurst int
	// SiteCacheTTL is how long an ingest_site answer stays in memory. At most 1
	// minute (E2 spec, section 6).
	SiteCacheTTL time.Duration
	// SiteStaleTTL is how long, after it expires, the last known answer for a
	// site is still valid when the database query fails. Zero (the default)
	// turns it off. At most 1 hour.
	SiteStaleTTL time.Duration
	// ProofSecret signs the challenges of the JS execution proof (#25). When
	// empty, the gateway generates a key at startup, and the tokens issued
	// before a restart (or by another replica) stop being valid.
	ProofSecret []byte
	// ProofBits is the proof difficulty: zero bits at the start of the SHA-256.
	ProofBits int
	// ProofTTL is the validity of a challenge.
	ProofTTL time.Duration
	// FingerprintLimit is the maximum number of distinct fingerprints per
	// truncated IP and site within FingerprintWindow (#26). Zero turns the
	// check off. The cap of 1000 bounds the scan done under the lock when a
	// count is full.
	FingerprintLimit  int
	FingerprintWindow time.Duration
	// RelayMaxInflight is the maximum number of relays to Umami at the same
	// time. Zero (the default) turns the limit off. RelayQueueWait is how long
	// a request waits for a slot before getting 503; 0 refuses immediately.
	RelayMaxInflight int
	RelayQueueWait   time.Duration
}

// Load builds the Config from getenv (normally os.Getenv).
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		ListenAddr:     or(getenv("LISTEN_ADDR"), ":8080"),
		DatabaseURL:    getenv("DATABASE_URL"),
		ClientIPHeader: or(getenv("CLIENT_IP_HEADER"), "x-stellytics-client-ip"),
		ScriptDir:      getenv("SCRIPT_DIR"),
	}
	var errs []error

	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}

	raw := getenv("UMAMI_URL")
	if raw == "" {
		errs = append(errs, errors.New("UMAMI_URL is required"))
	} else if u, err := url.Parse(raw); err != nil || u.Scheme == "" || u.Host == "" {
		errs = append(errs, fmt.Errorf("invalid UMAMI_URL: %q", raw))
	} else {
		c.UmamiURL = u
	}

	for _, s := range strings.Split(getenv("TRUSTED_PROXIES"), ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		p, err := parsePrefix(s)
		if err != nil {
			errs = append(errs, fmt.Errorf("TRUSTED_PROXIES: %w", err))
			continue
		}
		c.TrustedProxies = append(c.TrustedProxies, p)
	}

	var err error
	if c.RateLimit, err = parseFloat(getenv("RATE_LIMIT"), 20); err != nil || c.RateLimit <= 0 {
		errs = append(errs, fmt.Errorf("invalid RATE_LIMIT: %q", getenv("RATE_LIMIT")))
	}
	if c.RateBurst, err = parseInt(getenv("RATE_BURST"), 40); err != nil || c.RateBurst <= 0 {
		errs = append(errs, fmt.Errorf("invalid RATE_BURST: %q", getenv("RATE_BURST")))
	}
	if c.SiteCacheTTL, err = parseDuration(getenv("SITE_CACHE_TTL"), time.Minute); err != nil || c.SiteCacheTTL < 0 || c.SiteCacheTTL > time.Minute {
		errs = append(errs, fmt.Errorf("invalid SITE_CACHE_TTL: %q", getenv("SITE_CACHE_TTL")))
	}
	if c.SiteStaleTTL, err = parseDuration(getenv("SITE_STALE_TTL"), 0); err != nil || c.SiteStaleTTL < 0 || c.SiteStaleTTL > time.Hour {
		errs = append(errs, fmt.Errorf("invalid SITE_STALE_TTL (0 to 1h): %q", getenv("SITE_STALE_TTL")))
	}

	if s := getenv("PROOF_SECRET"); s != "" {
		if len(s) < 32 {
			errs = append(errs, errors.New("PROOF_SECRET needs at least 32 characters"))
		}
		c.ProofSecret = []byte(s)
	}
	if c.ProofBits, err = parseInt(getenv("PROOF_BITS"), 12); err != nil || c.ProofBits < 0 || c.ProofBits > 24 {
		errs = append(errs, fmt.Errorf("invalid PROOF_BITS (0 to 24): %q", getenv("PROOF_BITS")))
	}
	if c.ProofTTL, err = parseDuration(getenv("PROOF_TTL"), 10*time.Minute); err != nil || c.ProofTTL < time.Minute || c.ProofTTL > time.Hour {
		errs = append(errs, fmt.Errorf("invalid PROOF_TTL (1m to 1h): %q", getenv("PROOF_TTL")))
	}

	if c.FingerprintLimit, err = parseInt(getenv("FINGERPRINT_LIMIT"), 50); err != nil || c.FingerprintLimit < 0 || c.FingerprintLimit > 1000 {
		errs = append(errs, fmt.Errorf("invalid FINGERPRINT_LIMIT (0 to 1000): %q", getenv("FINGERPRINT_LIMIT")))
	}
	if c.FingerprintWindow, err = parseDuration(getenv("FINGERPRINT_WINDOW"), 10*time.Minute); err != nil || c.FingerprintWindow < time.Minute || c.FingerprintWindow > 24*time.Hour {
		errs = append(errs, fmt.Errorf("invalid FINGERPRINT_WINDOW (1m to 24h): %q", getenv("FINGERPRINT_WINDOW")))
	}

	if c.RelayMaxInflight, err = parseInt(getenv("RELAY_MAX_INFLIGHT"), 0); err != nil || c.RelayMaxInflight < 0 || c.RelayMaxInflight > 100000 {
		errs = append(errs, fmt.Errorf("invalid RELAY_MAX_INFLIGHT (0 to 100000): %q", getenv("RELAY_MAX_INFLIGHT")))
	}
	if c.RelayQueueWait, err = parseDuration(getenv("RELAY_QUEUE_WAIT"), 250*time.Millisecond); err != nil || c.RelayQueueWait < 0 || c.RelayQueueWait > 10*time.Second {
		errs = append(errs, fmt.Errorf("invalid RELAY_QUEUE_WAIT (0 to 10s): %q", getenv("RELAY_QUEUE_WAIT")))
	}

	return c, errors.Join(errs...)
}

// parsePrefix accepts a CIDR or a bare IP (treated as /32 or /128).
func parsePrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		return p.Masked(), err
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func parseFloat(s string, def float64) (float64, error) {
	if s == "" {
		return def, nil
	}
	return strconv.ParseFloat(s, 64)
}

func parseInt(s string, def int) (int, error) {
	if s == "" {
		return def, nil
	}
	return strconv.Atoi(s)
}

func parseDuration(s string, def time.Duration) (time.Duration, error) {
	if s == "" {
		return def, nil
	}
	return time.ParseDuration(s)
}
