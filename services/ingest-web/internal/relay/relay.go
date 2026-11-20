// Package relay validates the script's event and relays it to Umami's
// /api/send.
//
// The relayed payload is rebuilt with only the allowed fields. Fields that
// Umami would accept from the client and that would change the session identity
// or the origin of the event (id, ip, userAgent, timestamp, data, browser,
// os...) are dropped here.
package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
)

// Maximum sizes, in bytes, of the text fields.
const (
	MaxURL      = 2048
	MaxReferrer = 2048
	MaxTitle    = 500
	MaxHostname = 253
	MaxLanguage = 35
	MaxScreen   = 16

	// Limits of the custom event (#50).
	MaxName       = 50
	MaxDataKeys   = 10
	MaxDataKey    = 40
	MaxDataString = 100
	MaxDataNumber = 32 // characters of the literal
)

// Payload holds the allowed fields of a page view.
type Payload struct {
	Website  string `json:"website"`
	Hostname string `json:"hostname,omitempty"`
	URL      string `json:"url"`
	Referrer string `json:"referrer,omitempty"`
	Title    string `json:"title,omitempty"`
	Language string `json:"language,omitempty"`
	Screen   string `json:"screen,omitempty"`

	// Custom event (#50): Name and Data are only relayed after being validated
	// in validate. Data holds only string, number (json.Number) and boolean.
	Name string         `json:"name,omitempty"`
	Data map[string]any `json:"data,omitempty"`
}

// Proof is the JS execution proof that comes with the event (#25). It is never
// relayed to Umami.
type Proof struct {
	Token string `json:"t"`
	Nonce string `json:"n"`
}

// Event is the envelope the script sends. Umami receives only Type and Payload.
type Event struct {
	Type    string  `json:"type"`
	Payload Payload `json:"payload"`
	Proof   Proof   `json:"p"`
}

// ErrInvalid means an event outside the accepted format.
var ErrInvalid = errors.New("relay: invalid event")

// Decode reads a JSON event. Unknown fields are ignored, which already removes
// from the payload everything that is not in Payload.
func Decode(r io.Reader) (Event, error) {
	var ev Event
	dec := json.NewDecoder(r)
	// Numbers stay as json.Number: the relayed value is the one sent, without
	// rounding.
	dec.UseNumber()
	if err := dec.Decode(&ev); err != nil {
		return Event{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if dec.More() {
		return Event{}, fmt.Errorf("%w: content after the JSON", ErrInvalid)
	}
	if err := ev.validate(); err != nil {
		return Event{}, err
	}
	ev.Payload.Website = strings.ToLower(ev.Payload.Website)
	return ev, nil
}

func (ev Event) validate() error {
	p := ev.Payload
	switch {
	case ev.Type != "event":
		return fmt.Errorf("%w: type must be \"event\"", ErrInvalid)
	case !IsUUID(p.Website):
		return fmt.Errorf("%w: website must be a UUID", ErrInvalid)
	case p.URL == "":
		return fmt.Errorf("%w: url is required", ErrInvalid)
	}
	limits := []struct {
		name, v string
		max     int
	}{
		{"url", p.URL, MaxURL},
		{"referrer", p.Referrer, MaxReferrer},
		{"title", p.Title, MaxTitle},
		{"hostname", p.Hostname, MaxHostname},
		{"language", p.Language, MaxLanguage},
		{"screen", p.Screen, MaxScreen},
	}
	for _, l := range limits {
		if len(l.v) > l.max {
			return fmt.Errorf("%w: %s exceeds %d bytes", ErrInvalid, l.name, l.max)
		}
	}
	return validateCustom(p)
}

var (
	namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)
	keyPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// validateCustom checks the name and the properties of a custom event. Short
// name with a restricted charset; up to MaxDataKeys properties with a string
// (up to MaxDataString bytes), number or boolean value. Nested, null and list
// values are refused.
func validateCustom(p Payload) error {
	if p.Name == "" {
		if len(p.Data) > 0 {
			return fmt.Errorf("%w: data requires name", ErrInvalid)
		}
		return nil
	}
	if len(p.Name) > MaxName || !namePattern.MatchString(p.Name) {
		return fmt.Errorf("%w: name outside the format", ErrInvalid)
	}
	if len(p.Data) > MaxDataKeys {
		return fmt.Errorf("%w: data exceeds %d properties", ErrInvalid, MaxDataKeys)
	}
	for k, v := range p.Data {
		if len(k) > MaxDataKey || !keyPattern.MatchString(k) {
			return fmt.Errorf("%w: data key outside the format", ErrInvalid)
		}
		switch x := v.(type) {
		case string:
			if len(x) > MaxDataString {
				return fmt.Errorf("%w: data value exceeds %d bytes", ErrInvalid, MaxDataString)
			}
		case json.Number:
			// Short, finite literal: Umami may refuse the rest and the 502
			// would spend a slot.
			f, err := x.Float64()
			if len(x) > MaxDataNumber || err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
				return fmt.Errorf("%w: data number outside the format", ErrInvalid)
			}
		case bool:
		default:
			return fmt.Errorf("%w: data value must be a string, number or boolean", ErrInvalid)
		}
	}
	return nil
}

// IsUUID checks the canonical 8-4-4-4-12 hexadecimal format.
func IsUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// Client relays events to Umami.
type Client struct {
	sendURL      string
	heartbeatURL string
	ipHeader     string
	http         *http.Client
}

// NewClient points to base/api/send and sends the truncated IP in ipHeader.
func NewClient(base *url.URL, ipHeader string, hc *http.Client) *Client {
	return &Client{
		sendURL:      base.JoinPath("api", "send").String(),
		heartbeatURL: base.JoinPath("api", "heartbeat").String(),
		ipHeader:     ipHeader,
		http:         hc,
	}
}

// Heartbeat checks that Umami responds on /api/heartbeat.
func (c *Client) Heartbeat(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.heartbeatURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &UpstreamError{Status: resp.StatusCode}
	}
	return nil
}

// UpstreamError is a non-2xx response from Umami.
type UpstreamError struct{ Status int }

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("relay: umami responded %d", e.Status)
}

// Send relays ev with the original User-Agent and the already truncated IP. No
// other client header is relayed.
func (c *Client) Send(ctx context.Context, ev Event, userAgent string, truncatedIP netip.Addr) error {
	body, err := json.Marshal(struct {
		Type    string  `json:"type"`
		Payload Payload `json:"payload"`
	}{ev.Type, ev.Payload})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sendURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// Without the header, Go would send its own User-Agent and Umami would not
	// be able to detect bots.
	req.Header["User-Agent"] = []string{userAgent}
	req.Header.Set(c.ipHeader, truncatedIP.String())

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &UpstreamError{Status: resp.StatusCode}
	}
	return nil
}
