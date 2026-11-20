package clientip

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestTruncate(t *testing.T) {
	cases := map[string]string{
		"203.0.113.77":                 "203.0.113.0",
		"10.1.2.255":                   "10.1.2.0",
		"::ffff:203.0.113.77":          "203.0.113.0",
		"2001:db8:abcd:12:34:56:78:9a": "2001:db8:abcd::",
		"2001:db8::1":                  "2001:db8::",
		"::1":                          "::",
	}
	for in, want := range cases {
		if got := Truncate(netip.MustParseAddr(in)).String(); got != want {
			t.Errorf("Truncate(%s) = %s, want %s", in, got, want)
		}
	}
	if got := Truncate(netip.Addr{}); got.IsValid() {
		t.Errorf("Truncate(invalid) = %s, want invalid", got)
	}
}

func TestFromRequest(t *testing.T) {
	proxies := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("fd00::/8")}
	cases := []struct {
		name, remote, xff, want string
		trusted                 []netip.Prefix
	}{
		{"no proxy", "198.51.100.7:5000", "", "198.51.100.7", nil},
		{"XFF ignored without a trusted proxy", "198.51.100.7:5000", "203.0.113.77", "198.51.100.7", nil},
		{"XFF from an unlisted proxy", "198.51.100.7:5000", "203.0.113.77", "198.51.100.7", proxies},
		{"trusted proxy", "10.0.0.2:5000", "203.0.113.77", "203.0.113.77", proxies},
		{"chain with a forged entry", "10.0.0.2:5000", "1.2.3.4, 203.0.113.77, 10.0.0.9", "203.0.113.77", proxies},
		{"proxy without XFF", "10.0.0.2:5000", "", "10.0.0.2", proxies},
		{"invalid XFF", "10.0.0.2:5000", "junk", "10.0.0.2", proxies},
		{"IPv6", "[fd00::2]:5000", "2001:db8::1", "2001:db8::1", proxies},
		{"mapped IPv4", "[::ffff:198.51.100.7]:5000", "", "198.51.100.7", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/e", nil)
			req.RemoteAddr = c.remote
			if c.xff != "" {
				req.Header.Set("X-Forwarded-For", c.xff)
			}
			got, err := Resolver{Trusted: c.trusted}.FromRequest(req)
			if err != nil {
				t.Fatal(err)
			}
			if got.String() != c.want {
				t.Errorf("FromRequest = %s, want %s", got, c.want)
			}
		})
	}

	req := httptest.NewRequest("POST", "/e", nil)
	req.RemoteAddr = "not-an-ip"
	if _, err := (Resolver{}).FromRequest(req); err == nil {
		t.Error("invalid RemoteAddr gave no error")
	}
}
