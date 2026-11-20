package config

import (
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL": "postgresql://stellytics_ingest:x@db/stellytics",
		"UMAMI_URL":    "http://umami:3000",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != ":8080" || c.ClientIPHeader != "x-stellytics-client-ip" ||
		c.RateLimit != 20 || c.RateBurst != 40 || c.SiteCacheTTL != time.Minute || c.SiteStaleTTL != 0 ||
		c.ScriptDir != "" || len(c.TrustedProxies) != 0 || c.UmamiURL.Host != "umami:3000" ||
		c.ProofSecret != nil || c.ProofBits != 12 || c.ProofTTL != 10*time.Minute ||
		c.FingerprintLimit != 50 || c.FingerprintWindow != 10*time.Minute ||
		c.RelayMaxInflight != 0 || c.RelayQueueWait != 250*time.Millisecond {
		t.Errorf("unexpected defaults: %+v", c)
	}
}

func TestLoadTrustedProxies(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL":    "x",
		"UMAMI_URL":       "http://umami:3000",
		"TRUSTED_PROXIES": " 172.16.0.0/12, 10.0.0.5 ,fd00::/8, 192.168.1.9/24",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"172.16.0.0/12", "10.0.0.5/32", "fd00::/8", "192.168.1.0/24"}
	if len(c.TrustedProxies) != len(want) {
		t.Fatalf("TrustedProxies = %v", c.TrustedProxies)
	}
	for i, p := range c.TrustedProxies {
		if p.String() != want[i] {
			t.Errorf("TrustedProxies[%d] = %s, want %s", i, p, want[i])
		}
	}
}

func TestLoadErrors(t *testing.T) {
	cases := map[string]map[string]string{
		"no DATABASE_URL": {"UMAMI_URL": "http://umami:3000"},
		"no UMAMI_URL":    {"DATABASE_URL": "x"},
		"bad UMAMI_URL":   {"DATABASE_URL": "x", "UMAMI_URL": "umami"},
		"bad proxy":       {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "TRUSTED_PROXIES": "junk"},
		"bad rate":        {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RATE_LIMIT": "0"},
		"bad burst":       {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RATE_BURST": "-1"},
		"bad ttl":         {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "SITE_CACHE_TTL": "1 minute"},
		"long ttl":        {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "SITE_CACHE_TTL": "2m"},
		"bad stale":       {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "SITE_STALE_TTL": "1 hour"},
		"long stale":      {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "SITE_STALE_TTL": "2h"},
		"negative stale":  {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "SITE_STALE_TTL": "-1s"},
		"short secret":    {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "PROOF_SECRET": "short"},
		"too many bits":   {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "PROOF_BITS": "25"},
		"long proof":      {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "PROOF_TTL": "2h"},
		"negative limit":  {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "FINGERPRINT_LIMIT": "-1"},
		"high limit":      {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "FINGERPRINT_LIMIT": "1001"},
		"short window":    {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "FINGERPRINT_WINDOW": "30s"},
		"negative relay":  {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_MAX_INFLIGHT": "-1"},
		"high relay":      {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_MAX_INFLIGHT": "100001"},
		"junk relay":      {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_MAX_INFLIGHT": "many"},
		"negative wait":   {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_QUEUE_WAIT": "-1s"},
		"long wait":       {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_QUEUE_WAIT": "11s"},
		"junk wait":       {"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_QUEUE_WAIT": "fast"},
	}
	for name, m := range cases {
		if _, err := Load(env(m)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestLoadSiteStaleTTL(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "x", "UMAMI_URL": "http://u", "SITE_STALE_TTL": "1h"}
	c, err := Load(func(k string) string { return env[k] })
	if err != nil || c.SiteStaleTTL != time.Hour {
		t.Fatalf("SITE_STALE_TTL=1h: %v %v", c.SiteStaleTTL, err)
	}
}

func TestLoadRelayLimit(t *testing.T) {
	m := map[string]string{"DATABASE_URL": "x", "UMAMI_URL": "http://u", "RELAY_MAX_INFLIGHT": "100000", "RELAY_QUEUE_WAIT": "0"}
	c, err := Load(func(k string) string { return m[k] })
	if err != nil || c.RelayMaxInflight != 100000 || c.RelayQueueWait != 0 {
		t.Fatalf("limits: %+v %v", c, err)
	}
}
