// Package pgtest gathers what the Go integration tests need from the
// stellytics database: a database with the portal's migrations, without ever
// migrating the DATABASE_URL database outside Drizzle, and connections as the
// ingestion users.
package pgtest

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Database returns the URL of the database where the test runs: a temporary
// database with the portal's migrations, when the user can create databases,
// or the adminURL database itself, when the portal has already migrated it.
func Database(t *testing.T, adminURL string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	var canCreate bool
	err = conn.QueryRow(ctx, `SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&canCreate)
	if err != nil {
		t.Fatal(err)
	}
	if !canCreate {
		// Without a temporary database, only the database the portal has fully migrated will do.
		var applied int
		_ = conn.QueryRow(ctx, `SELECT count(*) FROM drizzle.__drizzle_migrations`).Scan(&applied)
		if total := len(migrationFiles(t)); applied < total {
			t.Skipf("the DATABASE_URL database has %d of %d portal migrations and the user cannot create a temporary "+
				"database: run pnpm --filter @stellytics/portal db:migrate (or start the portal) or use a user with CREATEDB",
				applied, total)
		}
		return adminURL
	}

	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("ingest_site_test_%x", b)
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, adminURL)
		if err != nil {
			t.Errorf("dropping %s: %v", name, err)
			return
		}
		defer conn.Close(ctx)
		if _, err := conn.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Errorf("dropping %s: %v", name, err)
		}
	})

	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	tmp, err := pgx.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer tmp.Close(ctx)
	applyMigrations(t, tmp)
	return u.String()
}

// applyMigrations applies the portal's migrations, in order, to an empty database.
func applyMigrations(t *testing.T, db *pgx.Conn) {
	t.Helper()
	ctx := context.Background()
	for _, f := range migrationFiles(t) {
		sql, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, stmt := range strings.Split(string(sql), "--> statement-breakpoint") {
			if strings.TrimSpace(stmt) == "" {
				continue
			}
			if _, err := db.Exec(ctx, stmt); err != nil {
				t.Fatalf("%s: %v (did infra/compose/postgres/init/02-ingest-roles.sh run?)", filepath.Base(f), err)
			}
		}
	}
}

// RoleURL replaces the URL's user and password with role/role, as in Compose
// and in CI, or uses the envVar URL when it exists.
func RoleURL(t *testing.T, adminURL, role, envVar string) string {
	t.Helper()
	if s := os.Getenv(envVar); s != "" {
		return s
	}
	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.User = url.UserPassword(role, role)
	return u.String()
}

// AssertDenied checks that err is permission denied (42501).
func AssertDenied(t *testing.T, what string, err error) {
	t.Helper()
	pgErr, ok := errors.AsType[*pgconn.PgError](err)
	if !ok || pgErr.Code != "42501" {
		t.Errorf("%s: want permission denied (42501), got %v", what, err)
	}
}

// NewUUID generates a UUID v4.
func NewUUID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// migrationFiles returns the portal's migrations, in order.
func migrationFiles(t *testing.T) []string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	files, err := filepath.Glob(filepath.Join(filepath.Dir(here), "../../../apps/portal/drizzle/*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("portal migrations not found: %v", err)
	}
	sort.Strings(files)
	return files
}
