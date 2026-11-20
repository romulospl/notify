//go:build e2e

// Isolation between tenants in API ingestion (#20 and #21; E2 spec, sections
// 6 and 8): changes made AFTER the key was already accepted take effect within
// the collector's cache (INGEST_KEY_CACHE_TTL: at most 60 s, 5 s in Compose).
//
//   - revoked key: it starts being refused;
//   - tenant removed by the operator: its key starts being refused, and works
//     again when the tenant is reactivated (D6).
//
// And the case that depends on the exporter (#31): a key of A sending data that
// claims to be B's is stored as A.
//
// The status changes directly in the database, as the portal's functions do
// (tested in apps/portal/test/isolation.test.ts). The refusal is 401 (HTTP) and
// Unauthenticated (gRPC), the same as for a nonexistent key.
package e2e

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// keyCacheTTL is the collector's INGEST_KEY_CACHE_TTL in Compose.
var keyCacheTTL = func() time.Duration {
	d, err := time.ParseDuration(env("COLLECTOR_KEY_CACHE_TTL", "5s"))
	if err != nil {
		panic(err)
	}
	return d
}()

func TestRevokedKeyIsRefusedWithinCacheTTL(t *testing.T) {
	db, user := isolationDB(t)
	key, _, _ := createKey(t, db, user, "active")
	expectAccepted(t, key)

	exec(t, db, `UPDATE ingest_key SET revoked_at = now() WHERE prefix = $1`, prefixOf(key))
	time.Sleep(keyCacheTTL + time.Second)
	expectRefused(t, key)
}

func TestRemovedTenantIsRefusedWithinCacheTTL(t *testing.T) {
	db, user := isolationDB(t)
	key, _, _ := createKey(t, db, user, "active")
	other, _, _ := createKey(t, db, user, "active")
	expectAccepted(t, key)

	setTenantStatus(t, db, key, "removed")
	time.Sleep(keyCacheTTL + time.Second)
	expectRefused(t, key)
	// The other tenants carry on.
	expectAccepted(t, other)

	setTenantStatus(t, db, key, "active")
	time.Sleep(keyCacheTTL + time.Second)
	expectAccepted(t, key)
}

// A key of A sending data that claims to be B's (E2 spec, section 8): everything
// is stored as A, and B is left without any row. The claim goes at every level
// OTLP allows (resource, scope and point or span), with B's real IDs, in two
// resources in the same request, over HTTP (metrics) and over gRPC (spans,
// which the collector turns into a metric).
func TestKeyOfAClaimingBIsStoredAsA(t *testing.T) {
	db, user := isolationDB(t)
	keyA, tenantA, serviceA := createKey(t, db, user, "active")
	keyC, tenantC, serviceC := createKey(t, db, user, "active")
	_, tenantB, serviceB := createKey(t, db, user, "active")

	md := metrics() // 1 request on /ledgers/{id}, see e2e_test.go
	rm := md.ResourceMetrics().At(0)
	claim(rm.Resource().Attributes(), tenantB, serviceB)
	claim(rm.ScopeMetrics().At(0).Scope().Attributes(), tenantB, serviceB)
	claim(rm.ScopeMetrics().At(0).Metrics().At(0).Histogram().DataPoints().At(0).Attributes(), tenantB, serviceB)
	rm.CopyTo(md.ResourceMetrics().AppendEmpty())
	if code := postHTTPWith(t, "Bearer "+keyA, md); code != http.StatusOK {
		t.Fatalf("A's metrics: status %d", code)
	}

	// Another tenant (C), with spans only: a service that sends metrics has its
	// spans ignored (D9 of the E5 spec), so the span path needs a service of
	// its own.
	td := spans("/ledgers/7", 3)
	rs := td.ResourceSpans().At(0)
	claim(rs.Resource().Attributes(), tenantB, serviceB)
	claim(rs.ScopeSpans().At(0).Scope().Attributes(), tenantB, serviceB)
	for i := range rs.ScopeSpans().At(0).Spans().Len() {
		claim(rs.ScopeSpans().At(0).Spans().At(i).Attributes(), tenantB, serviceB)
	}
	if err := exportSpansGRPC(t, "Bearer "+keyC, td); err != nil {
		t.Fatalf("C's spans: %v", err)
	}

	wantRows(t, db, tenantA, serviceA, []row{{"/ledgers/{id}", "GET", 200, 2}})
	wantRows(t, db, tenantC, serviceC, []row{{"/ledgers/{id}", "GET", 200, 3}})
	// The batch writes within 200 ms; anything headed for B would have arrived already.
	time.Sleep(time.Second)
	var ofB int
	if err := db.QueryRow(context.Background(),
		`SELECT count(*) FROM api_metric_1m WHERE tenant_id = $1 OR api_service_id = $2`,
		tenantB, serviceB).Scan(&ofB); err != nil {
		t.Fatal(err)
	}
	if ofB != 0 {
		t.Errorf("%d rows written to B's tenant or service", ofB)
	}
}

// claim puts in the attributes the names a client would use to say it is
// another tenant and another service.
func claim(attrs pcommon.Map, tenantID, serviceID string) {
	for _, k := range []string{"stellytics.tenant.id", "tenant.id", "tenant_id"} {
		attrs.PutStr(k, tenantID)
	}
	attrs.PutStr("stellytics.api_service.id", serviceID)
	attrs.PutStr("service.name", serviceID)
}

func isolationDB(t *testing.T) (*pgx.Conn, string) {
	t.Helper()
	ctx := context.Background()
	db, err := pgx.Connect(ctx, stellyticsDB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(context.Background()) })
	user := randomText(t, 16)
	exec(t, db, `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'e2e', $1 || '@collector.invalid', true)`, user)
	// After the keys and the tenants (createKey registers their cleanup later,
	// so it runs before this one).
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, user) })
	return db, user
}

// prefixOf takes the public prefix out of ntf_<prefix>_<secret>.
func prefixOf(key string) string { return key[4:12] }

func setTenantStatus(t *testing.T, db *pgx.Conn, key, status string) {
	t.Helper()
	tag, err := db.Exec(context.Background(),
		`UPDATE tenant SET status = $2, status_changed_at = now()
		 WHERE id = (SELECT tenant_id FROM ingest_key WHERE prefix = $1)`, prefixOf(key), status)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("tenant of key %s not found", prefixOf(key))
	}
}

func expectAccepted(t *testing.T, key string) {
	t.Helper()
	if code := postHTTP(t, "Bearer "+key); code != http.StatusOK {
		t.Fatalf("HTTP: status = %d, want 200", code)
	}
	if err := exportGRPC(t, "Bearer "+key); err != nil {
		t.Fatalf("gRPC: key refused: %v", err)
	}
}

func expectRefused(t *testing.T, key string) {
	t.Helper()
	if code := postHTTP(t, "Bearer "+key); code != http.StatusUnauthorized {
		t.Fatalf("HTTP: status = %d, want 401", code)
	}
	if err := exportGRPC(t, "Bearer "+key); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("gRPC: err = %v, want Unauthenticated", err)
	}
}
