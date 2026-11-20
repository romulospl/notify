package ingestkeyauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/romulospl/stellytics/services/internal/pgtest"
)

// Integration test of the Store with the real ingest_key_active view, as the
// stellytics_collector user. Needs DATABASE_URL (see internal/pgtest).
// COLLECTOR_DATABASE_URL replaces the connection used as stellytics_collector.
func TestPGStoreIntegration(t *testing.T) {
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
	// Close the connection only after the cleanups (t.Cleanup runs after the defers).
	t.Cleanup(func() { admin.Close(context.Background()) })

	userID := createUser(t, admin)
	active := createTenant(t, admin, "active")
	removed := createTenant(t, admin, "removed")
	svc := createService(t, admin, active, false)
	archived := createService(t, admin, active, true)
	svcOfRemoved := createService(t, admin, removed, false)

	good := createKey(t, admin, userID, active, svc, false)
	revoked := createKey(t, admin, userID, active, svc, true)
	ofArchived := createKey(t, admin, userID, active, archived, false)
	ofRemoved := createKey(t, admin, userID, removed, svcOfRemoved, false)

	pool, err := pgxpool.New(ctx, pgtest.RoleURL(t, adminURL, "stellytics_collector", "COLLECTOR_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	a := newAuthenticator(pgStore{pool: pool}, time.Minute, zap.NewNop())

	ctx2, err := a.Authenticate(ctx, header("Authorization", "Bearer "+good))
	if err != nil {
		t.Fatalf("active key refused: %v", err)
	}
	if got := attr(ctx2, AttrTenantID); got != active {
		t.Errorf("tenant = %q, want %q", got, active)
	}
	if got := attr(ctx2, AttrServiceID); got != svc {
		t.Errorf("service = %q, want %q", got, svc)
	}
	for name, key := range map[string]string{"revoked": revoked, "of an archived service": ofArchived, "of a removed tenant": ofRemoved} {
		if _, err := a.Authenticate(ctx, header("Authorization", "Bearer "+key)); err == nil {
			t.Errorf("%s key accepted", name)
		}
	}

	// stellytics_collector only reads the view.
	_, err = pool.Exec(ctx, `SELECT 1 FROM ingest_key LIMIT 1`)
	pgtest.AssertDenied(t, "SELECT on ingest_key", err)
}

// Last use (migration 0008): the function stores the day, once per day, only
// for an active key, and stellytics_collector gains nothing else on the table.
func TestPGStoreTouch(t *testing.T) {
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
	t.Cleanup(func() { admin.Close(context.Background()) })

	userID := createUser(t, admin)
	active := createTenant(t, admin, "active")
	removed := createTenant(t, admin, "removed")
	svc := createService(t, admin, active, false)
	svcOfRemoved := createService(t, admin, removed, false)
	good := createKey(t, admin, userID, active, svc, false)
	revoked := createKey(t, admin, userID, active, svc, true)
	ofRemoved := createKey(t, admin, userID, removed, svcOfRemoved, false)
	prefix := func(key string) string { return key[4:12] }

	pool, err := pgxpool.New(ctx, pgtest.RoleURL(t, adminURL, "stellytics_collector", "COLLECTOR_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := pgStore{pool: pool}

	lastUsed := func(key string) (d *string, xmin string) {
		t.Helper()
		if err := admin.QueryRow(ctx,
			`SELECT last_used_on::text, xmin::text FROM ingest_key WHERE prefix = $1`, prefix(key),
		).Scan(&d, &xmin); err != nil {
			t.Fatal(err)
		}
		return d, xmin
	}
	var today string
	if err := admin.QueryRow(ctx, `SELECT (now() AT TIME ZONE 'UTC')::date::text`).Scan(&today); err != nil {
		t.Fatal(err)
	}

	if d, _ := lastUsed(good); d != nil {
		t.Fatalf("last_used_on already set: %s", *d)
	}
	if err := store.Touch(ctx, prefix(good)); err != nil {
		t.Fatal(err)
	}
	d, xmin := lastUsed(good)
	if d == nil || *d != today {
		t.Fatalf("last_used_on = %v, want %s", d, today)
	}
	// Second call on the same day: the row is not rewritten.
	if err := store.Touch(ctx, prefix(good)); err != nil {
		t.Fatal(err)
	}
	if _, xmin2 := lastUsed(good); xmin2 != xmin {
		t.Errorf("the row was rewritten on the same day (xmin %s -> %s)", xmin, xmin2)
	}

	// Revoked, of a removed tenant and unknown prefix: nothing is written.
	for name, key := range map[string]string{"revoked": revoked, "of a removed tenant": ofRemoved} {
		if err := store.Touch(ctx, prefix(key)); err != nil {
			t.Fatal(err)
		}
		if d, _ := lastUsed(key); d != nil {
			t.Errorf("%s key was updated: %s", name, *d)
		}
	}
	if err := store.Touch(ctx, "zzzzzzzz"); err != nil {
		t.Fatal(err)
	}

	// Least privilege: no other write or read on the table or outside it.
	for what, q := range map[string]string{
		"UPDATE of last_used_on":     `UPDATE ingest_key SET last_used_on = NULL`,
		"UPDATE of revoked_at":       `UPDATE ingest_key SET revoked_at = NULL`,
		"UPDATE of key_hash":         `UPDATE ingest_key SET key_hash = key_hash`,
		"DELETE":                     `DELETE FROM ingest_key`,
		"SELECT of key_hash":         `SELECT key_hash FROM ingest_key`,
		"UPDATE on tenant":           `UPDATE tenant SET status = 'active'`,
		"SELECT on operator_api_key": `SELECT 1 FROM operator_api_key`,
		"UPDATE on api_service":      `UPDATE api_service SET name = name`,
	} {
		_, err := pool.Exec(ctx, q)
		pgtest.AssertDenied(t, what, err)
	}
}

func attr(ctx context.Context, name string) string {
	v, _ := clientAuth(ctx).GetAttribute(name).(string)
	return v
}

// createUser creates the author of the keys. Called before the tenants, its
// cleanup runs last, after the keys that reference it are already gone.
func createUser(t *testing.T, db *pgx.Conn) string {
	t.Helper()
	id := pgtest.NewUUID(t)
	if _, err := db.Exec(context.Background(),
		`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Test', $1 || '@collector.invalid', true)`, id,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id) })
	return id
}

func createTenant(t *testing.T, db *pgx.Conn, status string) string {
	t.Helper()
	var id string
	slug := "collector-" + pgtest.NewUUID(t)
	if err := db.QueryRow(context.Background(),
		`INSERT INTO tenant (name, slug, status) VALUES ($1, $1, $2) RETURNING id`, slug, status,
	).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = db.Exec(ctx, `DELETE FROM ingest_key WHERE tenant_id = $1`, id)
		_, _ = db.Exec(ctx, `DELETE FROM api_service WHERE tenant_id = $1`, id)
		_, _ = db.Exec(ctx, `DELETE FROM tenant WHERE id = $1`, id)
	})
	return id
}

func createService(t *testing.T, db *pgx.Conn, tenantID string, archived bool) string {
	t.Helper()
	var id string
	var archivedAt any
	if archived {
		archivedAt = time.Now()
	}
	if err := db.QueryRow(context.Background(),
		`INSERT INTO api_service (tenant_id, name, archived_at) VALUES ($1, $2, $3) RETURNING id`,
		tenantID, "api-"+pgtest.NewUUID(t)[:8], archivedAt,
	).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// createKey writes a key in the portal's format (#59) and returns the full key.
func createKey(t *testing.T, db *pgx.Conn, userID, tenantID, serviceID string, revoked bool) string {
	t.Helper()
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	b := make([]byte, 8+32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, 8)
	for i := range prefix {
		prefix[i] = alphabet[b[i]%32]
	}
	key := fmt.Sprintf("ntf_%s_%s", prefix, base64.RawURLEncoding.EncodeToString(b[8:]))
	hash := sha256.Sum256([]byte(key))
	var revokedAt any
	if revoked {
		revokedAt = time.Now()
	}
	if _, err := db.Exec(context.Background(),
		`INSERT INTO ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by, revoked_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`, serviceID, tenantID, string(prefix), hash[:], userID, revokedAt,
	); err != nil {
		t.Fatal(err)
	}
	return key
}
