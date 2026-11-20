// Package routenorm normalizes HTTP routes with the fixed rules of the RFP (#32).
//
// Contract in the E5 spec (docs/specs/e5-api-pipeline.md, section 3): the
// http.route sent by the client takes priority; without it, each path segment
// that is a UUID, Stellar address, hexadecimal hash or number becomes a
// placeholder, so that /accounts/GABC.../payments/ and
// /accounts/GXYZ.../payments count as the same route.
package routenorm

import (
	"net/url"
	"strings"
)

// Placeholders that replace the variable segments.
const (
	UUID    = "{uuid}"
	Address = "{address}"
	Hash    = "{hash}"
	ID      = "{id}"
)

// MaxLen is the maximum size, in bytes, of a stored route.
const MaxLen = 256

// minHashLen is the minimum number of hexadecimal digits of a {hash} (D8 of
// the spec), so as not to replace words like "cafe" or "add".
const minHashLen = 16

// Route returns the route of a request. clientRoute is the http.route sent by
// the client (the framework's template) and takes priority; path is the
// url.path or the http.target, which may carry a query string or be a full URL.
func Route(clientRoute, path string) string {
	if clientRoute != "" {
		return truncate(clientRoute)
	}
	return Path(path)
}

// Path normalizes a path: it strips query string and fragment, replaces the
// variable segments with placeholders, merges repeated slashes and strips the
// trailing slash.
func Path(path string) string {
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	// Full URL (old http.target or misconfigured client): only the path.
	if strings.Contains(path, "://") {
		if u, err := url.Parse(path); err == nil {
			path = u.EscapedPath()
		}
	}

	var b strings.Builder
	for _, seg := range strings.Split(path, "/") {
		if seg == "" {
			continue
		}
		b.WriteByte('/')
		b.WriteString(segment(seg))
	}
	if b.Len() == 0 {
		return "/"
	}
	out := b.String()
	// Route too long: cut at the end of the last whole segment that fits, so as
	// not to leave a piece of a segment that looks like another placeholder.
	if len(out) > MaxLen {
		if i := strings.LastIndexByte(out[:MaxLen+1], '/'); i > 0 {
			return out[:i]
		}
	}
	return truncate(out)
}

// segment replaces the segment with the first placeholder that matches, in the spec's order.
func segment(s string) string {
	switch {
	case isUUID(s):
		return UUID
	case isStellarAddress(s):
		return Address
	case isHexHash(s):
		return Hash
	case isDigits(s):
		return ID
	}
	return s
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		switch i {
		case 8, 13, 18, 23:
			if s[i] != '-' {
				return false
			}
		default:
			if !isHex(s[i]) {
				return false
			}
		}
	}
	return true
}

// isStellarAddress checks the StrKey format: G (account) or C (contract) with
// 56 characters, or M (muxed account) with 69, in uppercase base32. The
// checksum is not checked (spec, section 3).
func isStellarAddress(s string) bool {
	switch {
	case len(s) == 56 && (s[0] == 'G' || s[0] == 'C'):
	case len(s) == 69 && s[0] == 'M':
	default:
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

func isHexHash(s string) bool {
	if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X") {
		s = s[2:]
	}
	if len(s) < minHashLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isHex(s[i]) {
			return false
		}
	}
	return true
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// truncate cuts the route at MaxLen bytes without splitting a UTF-8 character.
func truncate(s string) string {
	if len(s) <= MaxLen {
		return s
	}
	s = s[:MaxLen]
	for len(s) > 0 && s[len(s)-1]&0xC0 == 0x80 {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] >= 0xC0 {
		s = s[:len(s)-1]
	}
	return s
}
