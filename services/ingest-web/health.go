package main

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// healthTimeout limita cada checagem das dependências; o -healthcheck do
// contêiner espera 3 s.
const healthTimeout = 2 * time.Second

// cachedHealth guarda o resultado da checagem por ttl. O /healthz é público:
// sem o cache, cada pedido viraria uma consulta ao Postgres e ao Umami. Quem
// chega durante uma checagem espera por ela em vez de disparar outra.
type cachedHealth struct {
	check func(context.Context) error
	ttl   time.Duration
	now   func() time.Time

	mu  sync.Mutex
	at  time.Time
	err error
}

func newCachedHealth(ttl time.Duration, check func(context.Context) error) *cachedHealth {
	return &cachedHealth{check: check, ttl: ttl, now: time.Now}
}

func (h *cachedHealth) Check(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.at.IsZero() && h.now().Sub(h.at) < h.ttl {
		return h.err
	}
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	h.err = h.check(ctx)
	h.at = h.now()
	return h.err
}

// healthz responde 200 só quando o gateway consegue entregar eventos: o
// Postgres (ingest_site, e onde o Umami grava) e o Umami respondem. É o que o
// monitoramento externo mede como disponibilidade da ingestão web.
func (g *gateway) healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if g.health != nil {
		if err := g.health(r.Context()); err != nil {
			g.log.Warn("healthz: dependência fora do ar", "err", err)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("unavailable\n"))
			return
		}
	}
	_, _ = w.Write([]byte("ok\n"))
}
