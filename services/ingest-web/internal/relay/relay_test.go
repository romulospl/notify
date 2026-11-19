package relay

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

func TestIsUUID(t *testing.T) {
	for s, want := range map[string]bool{
		"6f1c2b9e-3a4d-4c8e-9f00-1234567890ab": true,
		"6F1C2B9E-3A4D-4C8E-9F00-1234567890AB": true,
		"6f1c2b9e3a4d4c8e9f001234567890ab":     false,
		"6f1c2b9e-3a4d-4c8e-9f00-1234567890ag": false,
		"":                                     false,
	} {
		if IsUUID(s) != want {
			t.Errorf("IsUUID(%q) != %v", s, want)
		}
	}
}

func TestDecodeLowercasesWebsite(t *testing.T) {
	ev, err := Decode(strings.NewReader(`{"type":"event","payload":{"website":"6F1C2B9E-3A4D-4C8E-9F00-1234567890AB","url":"/"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Payload.Website != "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab" {
		t.Errorf("website = %s", ev.Payload.Website)
	}
}

func TestSendWithoutUserAgent(t *testing.T) {
	var gotUA []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Values("User-Agent")
	}))
	defer srv.Close()
	base, _ := url.Parse(srv.URL)
	c := NewClient(base, "x-stellytics-client-ip", srv.Client())
	ev := Event{Type: "event", Payload: Payload{Website: "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab", URL: "/"}}
	if err := c.Send(context.Background(), ev, "", netip.MustParseAddr("203.0.113.0")); err != nil {
		t.Fatal(err)
	}
	// Sem User-Agent do cliente, nada é inventado (nem o "Go-http-client").
	if len(gotUA) != 0 {
		t.Errorf("User-Agent enviado = %q", gotUA)
	}
}

func TestSendUpstreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	base, _ := url.Parse(srv.URL + "/umami/")
	c := NewClient(base, "x-stellytics-client-ip", srv.Client())
	err := c.Send(context.Background(), Event{Type: "event"}, "ua", netip.MustParseAddr("203.0.113.0"))
	if ue, ok := errors.AsType[*UpstreamError](err); !ok || ue.Status != 500 {
		t.Errorf("err = %v", err)
	}
}

func TestHeartbeat(t *testing.T) {
	status := http.StatusOK
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(status)
	}))
	defer srv.Close()
	base, _ := url.Parse(srv.URL + "/umami/")
	c := NewClient(base, "x-stellytics-client-ip", srv.Client())
	if err := c.Heartbeat(context.Background()); err != nil || gotPath != "/umami/api/heartbeat" {
		t.Errorf("Heartbeat = %v, path %q", err, gotPath)
	}
	status = http.StatusServiceUnavailable
	if ue, ok := errors.AsType[*UpstreamError](c.Heartbeat(context.Background())); !ok || ue.Status != 503 {
		t.Errorf("Heartbeat com 503 não devolveu UpstreamError")
	}
}
