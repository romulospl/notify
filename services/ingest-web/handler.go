package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/netip"
	"os"
	"path"
	"strings"

	"github.com/romulospl/stellytics/services/ingest-web/internal/clientip"
	"github.com/romulospl/stellytics/services/ingest-web/internal/fingerprint"
	"github.com/romulospl/stellytics/services/ingest-web/internal/proof"
	"github.com/romulospl/stellytics/services/ingest-web/internal/relay"
	"github.com/romulospl/stellytics/services/ingest-web/internal/site"
)

// maxBody is the maximum size of an event body.
const maxBody = 16 << 10

// fingerprints is the part of fingerprint.Counter that the handler uses.
type fingerprints interface {
	Admit(ip netip.Addr, site string, fp uint64) (ok, fresh bool)
	Forget(ip netip.Addr, site string, fp uint64)
}

// limiter is the part of limit.Limiter that the handler uses.
type limiter interface {
	Allow(key netip.Addr) bool
}

type gateway struct {
	sites   site.Store
	relay   relay.Sender
	limits  limiter
	ips     clientip.Resolver
	proofs  *proof.Issuer
	fps     fingerprints
	scripts *os.Root // nil turns /s/ off
	// health checks the dependencies on /healthz; nil always answers 200.
	health func(context.Context) error
	log    *slog.Logger
}

func (g *gateway) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /e", g.event)
	mux.HandleFunc("OPTIONS /e", g.preflight)
	mux.HandleFunc("GET /c", g.challenge)
	mux.HandleFunc("GET /healthz", g.healthz)
	if g.scripts != nil {
		mux.HandleFunc("GET /s/", g.script)
	}
	return g.recoverPanic(mux)
}

// recoverPanic answers 500 to a panic and logs only the error. Without it,
// net/http would log the panic together with the client's full address.
func (g *gateway) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				g.log.Error("panic in handler", "path", r.URL.Path, "panic", fmt.Sprint(v))
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// cors allows the call from any origin. No response uses a cookie, so there is
// no Allow-Credentials.
func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

func (g *gateway) preflight(w http.ResponseWriter, _ *http.Request) {
	cors(w)
	h := w.Header()
	h.Set("Access-Control-Allow-Methods", "POST")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	h.Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(http.StatusNoContent)
}

// event receives the page view from the script. The script sends the JSON as
// text/plain so as not to trigger a CORS preflight; application/json is also
// accepted.
func (g *gateway) event(w http.ResponseWriter, r *http.Request) {
	cors(w)

	ip, err := g.ips.FromRequest(r)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	truncated := clientip.Truncate(ip)
	if !g.limits.Allow(truncated) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}

	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mt != "text/plain" && mt != "application/json" {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}

	ev, err := relay.Decode(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Without a valid JS execution proof (#25), the event is dropped with the
	// same response as success.
	if err := g.proofs.Verify(ev.Payload.Website, ev.Proof.Token, ev.Proof.Nonce); err != nil {
		g.log.Debug("event dropped", "reason", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}

	active, err := g.sites.Active(r.Context(), ev.Payload.Website)
	if err != nil {
		g.log.Error("ingest_site query failed", "err", err)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	// E2 spec, section 6: a site that is unknown or does not accept ingestion
	// gets the same response as success, to give no hint to whoever probes IDs,
	// and the event is dropped.
	if !active {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Many different browsers on the same truncated IP and site (#26): the
	// fingerprints beyond the limit are dropped, with the same response as
	// success.
	fp := fingerprint.Of(r.UserAgent(), r.Header.Get("Accept-Language"), ev.Payload.Language, ev.Payload.Screen)
	admitted, fresh := g.fps.Admit(truncated, ev.Payload.Website, fp)
	if !admitted {
		g.log.Debug("event dropped", "reason", "too many fingerprints on the IP")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// The event only counts towards the fingerprint quota if it is relayed.
	// Saturation, client cancellation, an Umami failure and a panic (defer)
	// return the fingerprint slot this event has just taken.
	//
	// Known limitation: if another event from the same IP and the same
	// fingerprint went through between Admit and Forget (it saw the fingerprint
	// as "not new" and was written), Forget also removes its fingerprint from
	// the count. The quota is undercounted by one fingerprint, and only under
	// concurrency; the effect is loose, not strict.
	relayed := false
	if fresh {
		defer func() {
			if !relayed {
				g.fps.Forget(truncated, ev.Payload.Website, fp)
			}
		}()
	}

	if err := g.relay.Send(r.Context(), ev, r.UserAgent(), truncated); err != nil {
		if errors.Is(err, relay.ErrSaturated) {
			// Relays to Umami at the limit: the event is lost (the script does
			// not retry) and the aggregated counter records it. No per-event
			// log.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Context().Err() != nil {
			// The client gave up (or its deadline ran out) during the wait or
			// the relay: it is neither an Umami nor a gateway failure, and
			// there is nobody to read the response. No Error and no 502.
			g.log.Debug("event dropped", "reason", "client cancelled")
			return
		}
		g.log.Error("relay to umami failed", "err", err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	relayed = true
	w.WriteHeader(http.StatusNoContent)
}

// challenge hands out the challenge of the JS execution proof (#25) for the
// site in ?s=. It does not query ingest_site: the challenge does not say
// whether the site exists.
func (g *gateway) challenge(w http.ResponseWriter, r *http.Request) {
	cors(w)
	ip, err := g.ips.FromRequest(r)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !g.limits.Allow(clientip.Truncate(ip)) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	website := r.URL.Query().Get("s")
	if !relay.IsUUID(website) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(g.proofs.Challenge(strings.ToLower(website)))
}

// script serves the files in SCRIPT_DIR. Each version lives in /s/vX.Y.Z/ and
// never changes, which is why the cache is one year and immutable. os.Root
// prevents a path from leaving the directory.
func (g *gateway) script(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(r.URL.Path, "/s/")), "/")
	if name == "" {
		http.NotFound(w, r)
		return
	}
	f, err := g.scripts.Open(name)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			g.log.Warn("error opening script", "err", err)
		}
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	cors(w)
	h := w.Header()
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
	h.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}
