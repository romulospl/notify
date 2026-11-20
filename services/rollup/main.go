// Command rollup: rollup and retention job for the API metrics (#34).
//
// Every ROLLUP_INTERVAL it calls api_metric_maintain(ROLLUP_LOOKBACK) in the
// stellytics database, which creates the future partitions, rolls up
// api_metric_1m into api_metric_1h and api_metric_1d and drops the expired
// partitions (E5 spec, section 5). All the logic lives in the portal's
// migration 0005; this process only schedules. It exposes GET /healthz, which
// answers 200 while the last successful run is at most two intervals old.
//
// With UMAMI_DATABASE_URL set, the same run also applies the retention of the
// web events in the umami database (#154): it deletes events and sessions
// older than UMAMI_RETENTION_DAYS (default 183, about six months). Umami
// 3.4.1 has no retention setting of its own; this job does the pruning.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	DatabaseURL string
	ListenAddr  string
	Interval    time.Duration
	Lookback    time.Duration
	// Umami database and retention. Without UMAMI_DATABASE_URL the pruning is
	// off (the rest of the job carries on as normal).
	UmamiDatabaseURL   string
	UmamiRetentionDays int
}

// Default retention of the Umami events, in days: about six months.
// Value and rationale in docs/umami.md and docs/privacy.md (section 6).
const defaultUmamiRetentionDays = 183

func loadConfig(getenv func(string) string) (config, error) {
	c := config{
		DatabaseURL:        getenv("DATABASE_URL"),
		ListenAddr:         getenv("LISTEN_ADDR"),
		Interval:           15 * time.Minute,
		Lookback:           48 * time.Hour,
		UmamiDatabaseURL:   getenv("UMAMI_DATABASE_URL"),
		UmamiRetentionDays: defaultUmamiRetentionDays,
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is empty")
	}
	if c.ListenAddr == "" {
		c.ListenAddr = ":8080"
	}
	for name, dst := range map[string]*time.Duration{"ROLLUP_INTERVAL": &c.Interval, "ROLLUP_LOOKBACK": &c.Lookback} {
		if v := getenv(name); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil || d <= 0 {
				return c, fmt.Errorf("invalid %s: %q", name, v)
			}
			*dst = d
		}
	}
	if c.Lookback < 2*time.Hour {
		return c, errors.New("ROLLUP_LOOKBACK must be at least 2h")
	}
	if v := getenv("UMAMI_RETENTION_DAYS"); v != "" {
		d, err := strconv.Atoi(v)
		if err != nil || d < 0 {
			return c, fmt.Errorf("invalid UMAMI_RETENTION_DAYS: %q", v)
		}
		c.UmamiRetentionDays = d
	}
	if c.UmamiDatabaseURL == "" && getenv("UMAMI_RETENTION_DAYS") != "" {
		return c, errors.New("UMAMI_RETENTION_DAYS without UMAMI_DATABASE_URL has no effect")
	}
	return c, nil
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "queries the local /healthz and exits (for the container healthcheck)")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if *healthcheck {
		os.Exit(checkHealth(os.Getenv("LISTEN_ADDR")))
	}
	if err := run(log); err != nil {
		log.Error("rollup stopped", "err", err)
		os.Exit(1)
	}
}

// maintain runs one run of the job.
func maintain(ctx context.Context, pool *pgxpool.Pool, lookback time.Duration) error {
	_, err := pool.Exec(ctx, "SELECT api_metric_maintain(make_interval(secs => $1))", lookback.Seconds())
	return err
}

// pruneUmami applies the retention of the web events (#154): it deletes the
// events older than the retention and then the sessions of the same age that
// no longer back any event — the session of a visitor who keeps coming back
// stays, so that its recent events keep their browser, system and location.
// The Umami 3.4.1 schema has no foreign keys, so the order is only a choice;
// two runs at the same instant are idempotent. It returns the events and
// sessions deleted.
func pruneUmami(ctx context.Context, pool *pgxpool.Pool, days int) (events, sessions int64, err error) {
	tag, err := pool.Exec(ctx, "DELETE FROM website_event WHERE created_at < now() - make_interval(days => $1)", days)
	if err != nil {
		return 0, 0, fmt.Errorf("website_event: %w", err)
	}
	events = tag.RowsAffected()
	tag, err = pool.Exec(ctx, `DELETE FROM session s
		WHERE s.created_at < now() - make_interval(days => $1)
		  AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id)`, days)
	if err != nil {
		return events, 0, fmt.Errorf("session: %w", err)
	}
	return events, tag.RowsAffected(), nil
}

func run(log *slog.Logger) error {
	cfg, err := loadConfig(os.Getenv)
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

	// Pool of the umami database, only when the retention is on.
	var umamiPool *pgxpool.Pool
	if cfg.UmamiDatabaseURL != "" && cfg.UmamiRetentionDays > 0 {
		umamiPool, err = pgxpool.New(ctx, cfg.UmamiDatabaseURL)
		if err != nil {
			return fmt.Errorf("UMAMI_DATABASE_URL: %w", err)
		}
		defer umamiPool.Close()
		log.Info("Umami retention running", "days", cfg.UmamiRetentionDays)
	} else {
		log.Info("Umami retention off")
	}

	var lastOK atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if time.Since(time.Unix(0, lastOK.Load())) > 2*cfg.Interval {
			http.Error(w, "no recent run", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Addr: cfg.ListenAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	defer srv.Close()

	log.Info("rollup running", "interval", cfg.Interval.String(), "lookback", cfg.Lookback.String())
	for {
		start := time.Now()
		runCtx, cancel := context.WithTimeout(ctx, cfg.Interval)
		err := maintain(runCtx, pool, cfg.Lookback)
		cancel()
		if err != nil {
			log.Error("run failed", "err", err)
		} else {
			lastOK.Store(time.Now().UnixNano())
			log.Info("run finished", "duration", time.Since(start).String())
			if umamiPool != nil {
				umamiCtx, umamiCancel := context.WithTimeout(ctx, cfg.Interval)
				events, sessions, umamiErr := pruneUmami(umamiCtx, umamiPool, cfg.UmamiRetentionDays)
				umamiCancel()
				if umamiErr != nil {
					log.Error("Umami retention failed", "err", umamiErr)
				} else {
					log.Info("Umami retention finished", "events", events, "sessions", sessions)
				}
			}
		}
		next := time.NewTimer(nextRun(cfg.Interval, err != nil))
		select {
		case <-ctx.Done():
			next.Stop()
			return nil
		case err := <-errc:
			next.Stop()
			return err
		case <-next.C:
		}
	}
}

// retryDelay is the wait after a run that failed.
const retryDelay = 30 * time.Second

// nextRun tells how long to wait until the next run. After a failure (the
// database restarting, the migrations not yet applied) it tries again soon,
// instead of spending a whole interval without rolling up and with the
// healthcheck red. The job is idempotent, so repeating has no cost.
func nextRun(interval time.Duration, failed bool) time.Duration {
	if failed && retryDelay < interval {
		return retryDelay
	}
	return interval
}

// checkHealth plays the role of curl/wget in the shell-less image.
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
