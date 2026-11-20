package site

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/romulospl/stellytics/services/internal/pgtest"
)

// Integration test: it needs DATABASE_URL (the stellytics database, with the
// owner of the tables) and the users from 02-ingest-roles.sh, which CI and
// Compose create. INGEST_DATABASE_URL overrides the connection used as
// stellytics_ingest.
//
// The test never applies migrations to the DATABASE_URL database: they belong
// to the portal, which records them in Drizzle, and applying them from outside
// would make the portal fail when migrating later. With permission to create a
// database (CI), it creates a temporary database, applies the migrations there
// and drops it at the end. Without that permission (the Compose stellytics
// user), it uses the DATABASE_URL database if the portal has already migrated
// it, and skips the test if not.

func TestPGIntegration(t *testing.T) {
	adminURL := os.Getenv("DATABASE_URL")
	if adminURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	adminURL = pgtest.Database(t, adminURL)

	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	// Closes the connection only after the cleanups (t.Cleanup runs after the
	// defers).
	t.Cleanup(func() { admin.Close(context.Background()) })

	active := createTenant(t, admin, "active")
	removed := createTenant(t, admin, "removed")
	ids := map[string]string{"live": pgtest.NewUUID(t), "archived": pgtest.NewUUID(t), "ofRemoved": pgtest.NewUUID(t)}
	for _, s := range []struct {
		tenant, id, archived string
	}{
		{active, ids["live"], "NULL"},
		{active, ids["archived"], "now()"},
		{removed, ids["ofRemoved"], "NULL"},
	} {
		_, err := admin.Exec(ctx, `INSERT INTO site (tenant_id, name, domain, umami_website_id, archived_at)
			VALUES ($1, $2, $2, $3, `+s.archived+`)`, s.tenant, s.id, s.id)
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, id := range ids {
			_, _ = admin.Exec(ctx, `DELETE FROM site WHERE umami_website_id = $1`, id)
		}
		_, _ = admin.Exec(ctx, `DELETE FROM tenant WHERE id = ANY($1)`, []string{active, removed})
	})

	pool, err := pgxpool.New(ctx, pgtest.RoleURL(t, adminURL, "stellytics_ingest", "INGEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := PG{Pool: pool}

	want := map[string]bool{
		ids["live"]:                            true,
		strings.ToUpper(ids["live"]):           true,
		ids["archived"]:                        false,
		ids["ofRemoved"]:                       false,
		"00000000-0000-4000-8000-00000000dead": false,
	}
	for id, w := range want {
		got, err := store.Active(ctx, id)
		if err != nil {
			t.Fatalf("Active(%s): %v", id, err)
		}
		if got != w {
			t.Errorf("Active(%s) = %v, want %v", id, got, w)
		}
	}

	// stellytics_ingest only reads ingest_site.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM ingest_site`).Scan(&n); err != nil {
		t.Fatalf("SELECT on ingest_site: %v", err)
	}
	_, err = pool.Exec(ctx, `SELECT 1 FROM site`)
	pgtest.AssertDenied(t, "SELECT on site", err)
	_, err = pool.Exec(ctx, `SELECT 1 FROM "user"`)
	pgtest.AssertDenied(t, "SELECT on user", err)
	_, err = pool.Exec(ctx, `CREATE TABLE ingest_probe (x int)`)
	pgtest.AssertDenied(t, "CREATE TABLE", err)
}

func createTenant(t *testing.T, admin *pgx.Conn, status string) string {
	t.Helper()
	var id string
	slug := "go-" + pgtest.NewUUID(t)
	err := admin.QueryRow(context.Background(),
		`INSERT INTO tenant (name, slug, status) VALUES ($1, $1, $2) RETURNING id`, slug, status,
	).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
