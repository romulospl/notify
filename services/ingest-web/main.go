// Comando ingest-web: gateway entre o script de rastreamento e o Umami.
//
// Recebe os eventos em POST /e, confere o websiteId na visão ingest_site,
// trunca o IP e repassa ao /api/send do Umami pela rede interna. Também serve
// o script em /s/vX.Y.Z/ e expõe /healthz (Postgres e Umami no ar). A configuração vem do ambiente
// (ver internal/config e o README).
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/romulospl/stellytics/services/ingest-web/internal/clientip"
	"github.com/romulospl/stellytics/services/ingest-web/internal/config"
	"github.com/romulospl/stellytics/services/ingest-web/internal/fingerprint"
	"github.com/romulospl/stellytics/services/ingest-web/internal/limit"
	"github.com/romulospl/stellytics/services/ingest-web/internal/proof"
	"github.com/romulospl/stellytics/services/ingest-web/internal/relay"
	"github.com/romulospl/stellytics/services/ingest-web/internal/site"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "consulta o /healthz local e sai (para o healthcheck do contêiner)")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if *healthcheck {
		os.Exit(checkHealth(os.Getenv("LISTEN_ADDR")))
	}
	if err := run(log); err != nil {
		log.Error("gateway parou", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	defer pool.Close()

	var scripts *os.Root
	if cfg.ScriptDir != "" {
		if scripts, err = os.OpenRoot(cfg.ScriptDir); err != nil {
			return fmt.Errorf("SCRIPT_DIR: %w", err)
		}
		defer scripts.Close()
	}

	secret := cfg.ProofSecret
	if secret == nil {
		secret = make([]byte, 32)
		_, _ = rand.Read(secret)
		log.Warn("PROOF_SECRET vazio: chave sorteada, tokens não valem entre reinícios nem entre réplicas")
	}

	limits := limit.New(cfg.RateLimit, cfg.RateBurst, 10*time.Minute)
	go limits.Run(ctx, time.Minute)
	fps := fingerprint.New(cfg.FingerprintLimit, cfg.FingerprintWindow)
	go fps.Run(ctx, time.Minute)

	sites := site.NewCached(site.PG{Pool: pool}, cfg.SiteCacheTTL).WithStale(cfg.SiteStaleTTL)
	if cfg.SiteStaleTTL > 0 {
		go logStale(ctx, log, sites, time.Minute)
	}

	umami := relay.NewClient(cfg.UmamiURL, cfg.ClientIPHeader, &http.Client{Timeout: 10 * time.Second})
	var sender relay.Sender = umami
	if cfg.RelayMaxInflight > 0 {
		limited := relay.NewLimited(sender, cfg.RelayMaxInflight, cfg.RelayQueueWait)
		sender = limited
		go logSaturated(ctx, log, limited, time.Minute)
	}

	g := &gateway{
		sites:   sites,
		relay:   sender,
		limits:  limits,
		ips:     clientip.Resolver{Trusted: cfg.TrustedProxies},
		proofs:  proof.New(secret, cfg.ProofTTL, cfg.ProofBits),
		fps:     fps,
		scripts: scripts,
		health: newCachedHealth(5*time.Second, func(ctx context.Context) error {
			if err := pool.Ping(ctx); err != nil {
				return fmt.Errorf("postgres: %w", err)
			}
			if err := umami.Heartbeat(ctx); err != nil {
				return fmt.Errorf("umami: %w", err)
			}
			return nil
		}).Check,
		log: log,
	}
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           g.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Info("gateway no ar", "addr", cfg.ListenAddr, "scripts", cfg.ScriptDir != "")

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// logStale registra, no máximo uma vez por intervalo, quantas respostas
// vencidas foram servidas por falha do banco. Só o total vai ao log: nada de
// IP, User-Agent nem ID de site.
func logStale(ctx context.Context, log *slog.Logger, sites *site.Cached, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	var last uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n := sites.StaleServed(); n != last {
				log.Warn("ingest_site vencida servida por falha do banco", "respostas", n-last, "total", n)
				last = n
			}
		}
	}
}

// logSaturated registra, no máximo uma vez por intervalo e só quando mudar,
// quantos eventos foram descartados porque os repasses ao Umami estavam no
// limite. Só totais: nada de IP, User-Agent nem ID de site.
func logSaturated(ctx context.Context, log *slog.Logger, l *relay.Limited, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	var last uint64
	for {
		select {
		case <-ctx.Done():
			// Último minuto parcial antes de desligar.
			if n := l.Dropped(); n != last {
				log.Warn("eventos descartados por saturação do repasse ao umami", "descartados", n-last, "total", n, "em_voo", l.InFlight())
			}
			return
		case <-t.C:
			if n := l.Dropped(); n != last {
				log.Warn("eventos descartados por saturação do repasse ao umami", "descartados", n-last, "total", n, "em_voo", l.InFlight())
				last = n
			}
		}
	}
}

// checkHealth faz o papel de curl/wget na imagem sem shell.
func checkHealth(listen string) int {
	if listen == "" {
		listen = ":8080"
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
