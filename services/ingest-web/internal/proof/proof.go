// Package proof issues and verifies the JavaScript execution proof (#25).
//
// The script requests a challenge on GET /c, receives a token signed by the
// gateway and looks for a nonce such that SHA-256(token + ":" + nonce) starts
// with Bits zero bits. Each event carries the token and the nonce. A POST made
// directly, without going through the challenge, has no valid token and is
// dropped.
//
// It is not a barrier that cannot be bypassed: whoever reimplements the flow
// outside the browser gets the proof. The goal is to remove the cheap traffic
// (curl, scripts that only repeat a POST) and make the rest more expensive.
package proof

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"math/bits"
	"strconv"
	"strings"
	"time"
)

// Size limits for what comes from the client.
const (
	tokenLen = 8 + 8 + 16 // timestamp, random bytes and truncated HMAC
	maxNonce = 20
	// clockSkew tolerates a gateway clock slightly ahead on another replica.
	clockSkew = time.Minute
	// domain separates this HMAC from any other use of the same key.
	domain = "stellytics-proof-v1"
)

// Verify errors. All of them lead to the event being dropped.
var (
	ErrMissing   = errors.New("proof: no proof")
	ErrMalformed = errors.New("proof: malformed proof")
	ErrSignature = errors.New("proof: invalid signature")
	ErrExpired   = errors.New("proof: token expired")
	ErrWork      = errors.New("proof: insufficient work")
)

// Challenge is the response of GET /c.
type Challenge struct {
	Token string `json:"t"`
	Bits  int    `json:"d"`
}

// Issuer issues and verifies challenges with a secret key.
type Issuer struct {
	key  []byte
	ttl  time.Duration
	bits int
	now  func() time.Time
}

// New creates an Issuer. key must have at least 32 bytes.
func New(key []byte, ttl time.Duration, bits int) *Issuer {
	return &Issuer{key: key, ttl: ttl, bits: bits, now: time.Now}
}

// WithClock replaces the clock (for tests) and returns the Issuer itself.
func (i *Issuer) WithClock(now func() time.Time) *Issuer {
	i.now = now
	return i
}

// Challenge issues a token for website (UUID already in lowercase).
func (i *Issuer) Challenge(website string) Challenge {
	raw := make([]byte, tokenLen)
	binary.BigEndian.PutUint64(raw[0:8], uint64(i.now().Unix()))
	_, _ = rand.Read(raw[8:16])
	copy(raw[16:], i.mac(raw[0:16], website))
	return Challenge{Token: base64.RawURLEncoding.EncodeToString(raw), Bits: i.bits}
}

// Verify checks the token and the nonce sent with an event for website.
func (i *Issuer) Verify(website, token, nonce string) error {
	if token == "" && nonce == "" {
		return ErrMissing
	}
	if len(token) != base64.RawURLEncoding.EncodedLen(tokenLen) || nonce == "" || len(nonce) > maxNonce {
		return ErrMalformed
	}
	if _, err := strconv.ParseUint(nonce, 10, 64); err != nil {
		return ErrMalformed
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return ErrMalformed
	}
	if !hmac.Equal(raw[16:], i.mac(raw[0:16], website)) {
		return ErrSignature
	}
	issued := time.Unix(int64(binary.BigEndian.Uint64(raw[0:8])), 0)
	now := i.now()
	if now.Sub(issued) > i.ttl || issued.Sub(now) > clockSkew {
		return ErrExpired
	}
	if !Solved(token, nonce, i.bits) {
		return ErrWork
	}
	return nil
}

func (i *Issuer) mac(head []byte, website string) []byte {
	h := hmac.New(sha256.New, i.key)
	h.Write([]byte(domain))
	h.Write(head)
	h.Write([]byte(strings.ToLower(website)))
	return h.Sum(nil)[:16]
}

// Solved says whether SHA-256(token + ":" + nonce) starts with at least n zero
// bits.
func Solved(token, nonce string, n int) bool {
	sum := sha256.Sum256([]byte(token + ":" + nonce))
	return LeadingZeros(sum[:]) >= n
}

// LeadingZeros counts the zero bits at the start of b.
func LeadingZeros(b []byte) int {
	n := 0
	for _, c := range b {
		if c != 0 {
			return n + bits.LeadingZeros8(c)
		}
		n += 8
	}
	return n
}

// Solve finds a nonce for token, as the script does in the browser. Used in the
// tests and in the end-to-end test.
func Solve(token string, n int) string {
	for i := uint64(0); ; i++ {
		nonce := strconv.FormatUint(i, 10)
		if Solved(token, nonce, n) {
			return nonce
		}
	}
}
