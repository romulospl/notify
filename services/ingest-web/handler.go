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

// maxBody é o tamanho máximo do corpo de um evento.
const maxBody = 16 << 10

// fingerprints é a parte do fingerprint.Counter que o handler usa.
type fingerprints interface {
	Admit(ip netip.Addr, site string, fp uint64) (ok, fresh bool)
	Forget(ip netip.Addr, site string, fp uint64)
}

// limiter é a parte do limit.Limiter que o handler usa.
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
	scripts *os.Root // nil desliga /s/
	// health confere as dependências no /healthz; nil responde sempre 200.
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

// recoverPanic responde 500 a um panic e registra só o erro. Sem ele, o
// net/http registraria o panic junto com o endereço completo do cliente.
func (g *gateway) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				g.log.Error("panic no handler", "path", r.URL.Path, "panic", fmt.Sprint(v))
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// cors libera a chamada de qualquer origem. Nenhuma resposta usa cookie, então
// não há Allow-Credentials.
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

// event recebe o page view do script. O script manda o JSON como text/plain
// para não disparar preflight de CORS; application/json também é aceito.
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

	// Sem prova de execução de JS válida (#25), o evento é descartado com a
	// mesma resposta do sucesso.
	if err := g.proofs.Verify(ev.Payload.Website, ev.Proof.Token, ev.Proof.Nonce); err != nil {
		g.log.Debug("evento descartado", "reason", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}

	active, err := g.sites.Active(r.Context(), ev.Payload.Website)
	if err != nil {
		g.log.Error("consulta à ingest_site falhou", "err", err)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	// Spec do E2, seção 6: site desconhecido ou que não aceita ingestão recebe a
	// mesma resposta do sucesso, para não dar pista a quem testa IDs, e o evento
	// é descartado.
	if !active {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Muitos navegadores diferentes no mesmo IP truncado e site (#26): as
	// fingerprints além do limite são descartadas, com a mesma resposta do sucesso.
	fp := fingerprint.Of(r.UserAgent(), r.Header.Get("Accept-Language"), ev.Payload.Language, ev.Payload.Screen)
	admitted, fresh := g.fps.Admit(truncated, ev.Payload.Website, fp)
	if !admitted {
		g.log.Debug("evento descartado", "reason", "fingerprints demais no IP")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// O evento só conta para a cota de fingerprints se for repassado. Saturação,
	// cancelamento do cliente, falha do Umami e panic (defer) devolvem a vaga de
	// fingerprint que este evento acabou de ocupar.
	//
	// Limite conhecido: se outro evento do mesmo IP e da mesma fingerprint passou
	// entre o Admit e o Forget (viu a fingerprint como "não nova" e foi gravado),
	// o Forget também tira a fingerprint dele da conta. A cota fica subcontada
	// por uma fingerprint, e só sob concorrência; o efeito é frouxo, não rígido.
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
			// Repasses ao Umami no limite: o evento é perdido (o script não tenta
			// de novo) e o contador agregado registra. Sem log por evento.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Context().Err() != nil {
			// O cliente desistiu (ou estourou o prazo dele) durante a espera ou o
			// repasse: não é falha do Umami nem do gateway, não há quem leia a
			// resposta. Sem Error e sem 502.
			g.log.Debug("evento descartado", "reason", "cliente cancelou")
			return
		}
		g.log.Error("repasse ao umami falhou", "err", err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	relayed = true
	w.WriteHeader(http.StatusNoContent)
}

// challenge entrega o desafio da prova de execução de JS (#25) para o site
// em ?s=. Não consulta a ingest_site: o desafio não diz se o site existe.
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

// script serve os arquivos de SCRIPT_DIR. Cada versão fica em /s/vX.Y.Z/ e
// nunca muda, por isso o cache é de um ano e imutável. os.Root impede que um
// caminho saia da pasta.
func (g *gateway) script(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(r.URL.Path, "/s/")), "/")
	if name == "" {
		http.NotFound(w, r)
		return
	}
	f, err := g.scripts.Open(name)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			g.log.Warn("erro ao abrir script", "err", err)
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
