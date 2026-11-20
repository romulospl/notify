package main

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/romulospl/stellytics/services/internal/pgtest"
)

func TestLoadConfig(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://x"}
	get := func(k string) string { return env[k] }
	c, err := loadConfig(get)
	if err != nil || c.Interval != 15*time.Minute || c.Lookback != 48*time.Hour || c.ListenAddr != ":8080" {
		t.Fatalf("defaults: %+v, %v", c, err)
	}
	// Umami retention: without UMAMI_DATABASE_URL it is off, with the default
	// number of days untouched (docs/umami.md).
	if c.UmamiDatabaseURL != "" || c.UmamiRetentionDays != defaultUmamiRetentionDays {
		t.Errorf("Umami retention by default: %+v", c)
	}
	for k, v := range map[string]string{"ROLLUP_INTERVAL": "abc", "ROLLUP_LOOKBACK": "1h"} {
		env[k] = v
		if _, err := loadConfig(get); err == nil {
			t.Errorf("%s=%s should fail", k, v)
		}
		delete(env, k)
	}
	delete(env, "DATABASE_URL")
	if _, err := loadConfig(get); err == nil {
		t.Error("without DATABASE_URL it should fail")
	}
}

// The Umami retention (#154): on with UMAMI_DATABASE_URL, off with 0, and it
// refuses invalid days or days without a database.
func TestLoadConfigUmami(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://x", "UMAMI_DATABASE_URL": "postgres://umami"}
	get := func(k string) string { return env[k] }
	c, err := loadConfig(get)
	if err != nil || c.UmamiDatabaseURL != "postgres://umami" || c.UmamiRetentionDays != defaultUmamiRetentionDays {
		t.Fatalf("retention default: %+v, %v", c, err)
	}
	env["UMAMI_RETENTION_DAYS"] = "0"
	if c, err = loadConfig(get); err != nil || c.UmamiRetentionDays != 0 {
		t.Fatalf("0 turns the pruning off: %+v, %v", c, err)
	}
	for _, v := range []string{"-1", "abc"} {
		env["UMAMI_RETENTION_DAYS"] = v
		if _, err := loadConfig(get); err == nil {
			t.Errorf("UMAMI_RETENTION_DAYS=%s should fail", v)
		}
	}
	delete(env, "UMAMI_DATABASE_URL")
	delete(env, "UMAMI_RETENTION_DAYS")
	env["UMAMI_RETENTION_DAYS"] = "30"
	if _, err := loadConfig(get); err == nil {
		t.Error("days without UMAMI_DATABASE_URL should fail")
	}
}

// Rolls up a 1-minute point from two hours ago through the same call as the service, twice.
func TestNextRun(t *testing.T) {
	for _, c := range []struct {
		interval time.Duration
		failed   bool
		want     time.Duration
	}{
		{15 * time.Minute, false, 15 * time.Minute},
		{15 * time.Minute, true, retryDelay},
		{10 * time.Second, true, 10 * time.Second},
	} {
		if got := nextRun(c.interval, c.failed); got != c.want {
			t.Errorf("nextRun(%s, %v) = %s, want %s", c.interval, c.failed, got, c.want)
		}
	}
}

func TestMaintain(t *testing.T) {
	adminURL := os.Getenv("DATABASE_URL")
	if adminURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	adminURL = pgtest.Database(t, adminURL)
	pool, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	tenantID, serviceID := pgtest.NewUUID(t), pgtest.NewUUID(t)
	t.Cleanup(func() {
		for _, tbl := range []string{"api_metric_1m", "api_metric_1h", "api_metric_1d"} {
			_, _ = pool.Exec(context.Background(), "DELETE FROM "+tbl+" WHERE tenant_id = $1", tenantID)
		}
	})
	at := time.Now().UTC().Truncate(time.Hour).Add(-2 * time.Hour)
	_, err = pool.Exec(ctx, `INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method,
		status_code, request_count, duration_sum, duration_buckets)
		VALUES ($1, $2, $3, '/r', 'GET', 200, 3, 0.3, '{0,0,0,3,0,0,0,0,0,0,0,0,0,0,0}')`, at, tenantID, serviceID)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := maintain(ctx, pool, 48*time.Hour); err != nil {
			t.Fatal(err)
		}
	}
	for _, tbl := range []string{"api_metric_1h", "api_metric_1d"} {
		var n int64
		if err := pool.QueryRow(ctx, "SELECT sum(request_count) FROM "+tbl+" WHERE tenant_id = $1", tenantID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 3 {
			t.Errorf("%s: %d requests, expected 3", tbl, n)
		}
	}
}

// The Umami pruning (#154): it deletes the old event and session, and keeps
// the old session that still backs a recent event.
func TestPruneUmami(t *testing.T) {
	adminURL := os.Getenv("DATABASE_URL")
	if adminURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	// Its own database, without the portal's migrations: the Umami schema has
	// tables with the same names (session, website_event) that the migrations create.
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	var canCreate bool
	if err := admin.QueryRow(ctx, `SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&canCreate); err != nil {
		t.Fatal(err)
	}
	if !canCreate {
		t.Skip("the DATABASE_URL user cannot create a database for the Umami schema")
	}
	name := "rollup_prune_test_" + pgtest.NewUUID(t)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		c, err := pgx.Connect(ctx, adminURL)
		if err != nil {
			t.Errorf("dropping %s: %v", name, err)
			return
		}
		defer c.Close(ctx)
		if _, err := c.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Errorf("dropping %s: %v", name, err)
		}
	})
	admin.Close(ctx)

	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	// Only what the pruning touches in the Umami 3.4.1 schema (keys on
	// website_id/event_id omitted; the real schema has no foreign keys).
	_, err = pool.Exec(ctx, `CREATE TABLE session (session_id uuid primary key, created_at timestamptz not null);
		CREATE TABLE website_event (event_id uuid primary key, session_id uuid not null,
			created_at timestamptz not null default CURRENT_TIMESTAMP)`)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	old := now.AddDate(0, 0, -400)
	recent := now.Add(-24 * time.Hour)
	oldAlone, oldWithRecent, recentSession := pgtest.NewUUID(t), pgtest.NewUUID(t), pgtest.NewUUID(t)
	oldEvent, recentEvent := pgtest.NewUUID(t), pgtest.NewUUID(t)
	_, err = pool.Exec(ctx, `INSERT INTO session (session_id, created_at) VALUES
		($1, $4), ($2, $4), ($3, $5)`,
		oldAlone, oldWithRecent, recentSession, old, recent)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO website_event (event_id, session_id, created_at) VALUES
		($1, $2, $4), ($3, $6, $5)`,
		oldEvent, oldAlone, recentEvent, old, recent, oldWithRecent)
	if err != nil {
		t.Fatal(err)
	}

	// Expected: the old event and the old session without events go; the old
	// session that backs a recent event and the recent session stay.
	events, sessions, err := pruneUmami(ctx, pool, defaultUmamiRetentionDays)
	if err != nil {
		t.Fatal(err)
	}
	if events != 1 || sessions != 1 {
		t.Fatalf("deleted: %d events, %d sessions; expected 1 and 1", events, sessions)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM website_event WHERE session_id = $1", oldWithRecent).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("did the recent event of the old session survive? count=%d", n)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM session WHERE session_id = $1", oldWithRecent).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Error("old session with a recent event should stay")
	}
	// Idempotent: a second run deletes nothing.
	if events, sessions, err = pruneUmami(ctx, pool, defaultUmamiRetentionDays); err != nil || events != 0 || sessions != 0 {
		t.Fatalf("second run: %d events, %d sessions, %v; expected nothing", events, sessions, err)
	}
}
