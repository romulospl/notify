package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestHealthzDependencyDown(t *testing.T) {
	down := errors.New("umami: fora do ar")
	s := newSetup(t, func(g *gateway) {
		g.health = func(context.Context) error { return down }
	})
	resp, err := http.Get(s.server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("status = %d, Cache-Control = %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	if code := checkHealth(s.server.Listener.Addr().String()); code != 1 {
		t.Errorf("checkHealth = %d, quero 1", code)
	}
}

func TestCachedHealth(t *testing.T) {
	calls := 0
	var result error
	now := time.Unix(1000, 0)
	h := newCachedHealth(5*time.Second, func(ctx context.Context) error {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("checagem sem prazo")
		}
		return result
	})
	h.now = func() time.Time { return now }

	if err := h.Check(context.Background()); err != nil || calls != 1 {
		t.Fatalf("primeira checagem: err %v, calls %d", err, calls)
	}
	result = errors.New("postgres: fora do ar")
	now = now.Add(4 * time.Second)
	if err := h.Check(context.Background()); err != nil || calls != 1 {
		t.Errorf("dentro do ttl deveria reusar o resultado: err %v, calls %d", err, calls)
	}
	now = now.Add(2 * time.Second)
	if err := h.Check(context.Background()); err == nil || calls != 2 {
		t.Errorf("depois do ttl deveria checar de novo: err %v, calls %d", err, calls)
	}
}
