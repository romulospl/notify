// Package clientip finds the client's IP and truncates it before any use.
//
// The full IP only exists in the request's memory: what leaves the gateway (to
// Umami or to the rate limit) is always the result of Truncate.
package clientip

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Truncate zeroes the last IPv4 octet and everything after the /48 in IPv6. An
// IPv4 mapped into IPv6 (::ffff:a.b.c.d) is treated as IPv4.
func Truncate(a netip.Addr) netip.Addr {
	a = a.Unmap()
	bits := 48
	if a.Is4() {
		bits = 24
	}
	p, err := a.Prefix(bits)
	if err != nil {
		return netip.Addr{}
	}
	return p.Addr()
}

// Resolver finds the client's IP from the request.
type Resolver struct {
	// Trusted are the networks of the proxies (Caddy) whose X-Forwarded-For is
	// honoured.
	Trusted []netip.Prefix
}

// ErrNoIP means RemoteAddr does not hold a valid IP.
var ErrNoIP = errors.New("clientip: invalid remote address")

// FromRequest returns the client's IP, still complete. The caller must pass the
// result through Truncate before using it outside the request.
//
// X-Forwarded-For is only read when the connection comes from a trusted proxy.
// In it, the client is the first address from right to left that does not
// belong to a trusted proxy; entries to its left may have been forged.
func (r Resolver) FromRequest(req *http.Request) (netip.Addr, error) {
	remote, err := parseHostPort(req.RemoteAddr)
	if err != nil {
		return netip.Addr{}, ErrNoIP
	}
	if !r.trusted(remote) {
		return remote, nil
	}

	var hops []string
	for _, v := range req.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	client := remote
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		client = a.Unmap()
		if !r.trusted(client) {
			break
		}
	}
	return client, nil
}

func (r Resolver) trusted(a netip.Addr) bool {
	for _, p := range r.Trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func parseHostPort(s string) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(s)
	if err != nil {
		host = s
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, err
	}
	return a.Unmap(), nil
}
