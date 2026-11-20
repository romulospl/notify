//go:build e2e

// End-to-end test of the collector (#30) against the Docker Compose environment:
//
//	docker compose up -d --build --wait
//	cd services && go test -tags e2e ./collector/e2e/...
//
// It creates in the stellytics database an active tenant and a removed one, each
// with an ingest key in the portal's format (#59), and sends OTLP to the
// collector container over HTTP and gRPC. The active tenant's key passes; the
// removed one's, a wrong key and a missing key get 401 / Unauthenticated. The
// addresses can be changed with COLLECTOR_HTTP_URL, COLLECTOR_GRPC_ADDR and
// STELLYTICS_DATABASE_URL.
package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	httpURL      = env("COLLECTOR_HTTP_URL", "http://127.0.0.1:4318")
	grpcAddr     = env("COLLECTOR_GRPC_ADDR", "127.0.0.1:4317")
	stellyticsDB = env("STELLYTICS_DATABASE_URL", "postgresql://stellytics:stellytics@127.0.0.1:5432/stellytics")
)

func TestCollectorAuth(t *testing.T) {
	ctx := context.Background()
	db, err := pgx.Connect(ctx, stellyticsDB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(context.Background()) })

	user := randomText(t, 16)
	exec(t, db, `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'e2e', $1 || '@collector.invalid', true)`, user)
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, user) })
	good, goodTenant, goodService := createKey(t, db, user, "active")
	ofRemoved, _, _ := createKey(t, db, user, "removed")
	wrong := good[:len(good)-1] + flip(good[len(good)-1])

	for name, c := range map[string]struct {
		auth string
		ok   bool
	}{
		"no key":           {"", false},
		"wrong key":        {"Bearer " + wrong, false},
		"removed tenant":   {"Bearer " + ofRemoved, false},
		"valid key":        {"Bearer " + good, true},
		"lowercase scheme": {"bearer " + good, true},
	} {
		t.Run("HTTP/"+name, func(t *testing.T) {
			want := http.StatusUnauthorized
			if c.ok {
				want = http.StatusOK
			}
			if code := postHTTP(t, c.auth); code != want {
				t.Errorf("status = %d, want %d", code, want)
			}
		})
		t.Run("gRPC/"+name, func(t *testing.T) {
			err := exportGRPC(t, c.auth)
			if c.ok && err != nil {
				t.Errorf("valid key refused: %v", err)
			}
			if !c.ok && status.Code(err) != codes.Unauthenticated {
				t.Errorf("err = %v, want Unauthenticated", err)
			}
		})
	}

	// The four accepted calls (HTTP and gRPC, "Bearer" and "bearer") become a
	// single row, summed. Waiting for it also keeps the test cleanup from
	// running before the collector's batch writes.
	wantRows(t, db, goodTenant, goodService, []row{{"/ledgers/{id}", "GET", 200, 4}})
}

// metrics builds a point of http.server.request.duration, as an SDK sends it.
func metrics() pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "e2e")
	m := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName("http.server.request.duration")
	m.SetUnit("s")
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := h.DataPoints().AppendEmpty()
	dp.SetCount(1)
	dp.SetSum(0.02)
	dp.ExplicitBounds().FromRaw([]float64{0.005, 0.01, 0.025})
	dp.BucketCounts().FromRaw([]uint64{0, 0, 1, 0})
	dp.Attributes().PutStr("http.route", "/ledgers/{id}")
	dp.Attributes().PutStr("http.request.method", "GET")
	dp.Attributes().PutInt("http.response.status_code", 200)
	return md
}

func postHTTP(t *testing.T, auth string) int {
	t.Helper()
	body, err := pmetricotlp.NewExportRequestFromMetrics(metrics()).MarshalProto()
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPost, httpURL+"/v1/metrics", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("collector down: %v", err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func exportGRPC(t *testing.T, auth string) error {
	t.Helper()
	conn, err := grpc.NewClient(grpcAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if auth != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", auth)
	}
	_, err = pmetricotlp.NewGRPCClient(conn).Export(ctx, pmetricotlp.NewExportRequestFromMetrics(metrics()))
	return err
}

// createKey creates a tenant with the given status, a service and a key in the
// portal's format (#59), and returns the full key, the tenant and the service.
func createKey(t *testing.T, db *pgx.Conn, user, tenantStatus string) (key, tenantID, serviceID string) {
	t.Helper()
	ctx := context.Background()
	slug := "collector-e2e-" + randomText(t, 12)
	if err := db.QueryRow(ctx, `INSERT INTO tenant (name, slug, status) VALUES ($1, $1, $2) RETURNING id`,
		slug, tenantStatus).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `INSERT INTO api_service (tenant_id, name) VALUES ($1, 'e2e') RETURNING id`,
		tenantID).Scan(&serviceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = db.Exec(ctx, `DELETE FROM api_metric_1m WHERE tenant_id = $1`, tenantID)
		_, _ = db.Exec(ctx, `DELETE FROM ingest_key WHERE tenant_id = $1`, tenantID)
		_, _ = db.Exec(ctx, `DELETE FROM api_service WHERE tenant_id = $1`, tenantID)
		_, _ = db.Exec(ctx, `DELETE FROM tenant WHERE id = $1`, tenantID)
	})

	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	b := make([]byte, 8+32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, 8)
	for i := range prefix {
		prefix[i] = alphabet[b[i]%32]
	}
	key = "ntf_" + string(prefix) + "_" + base64.RawURLEncoding.EncodeToString(b[8:])
	hash := sha256.Sum256([]byte(key))
	exec(t, db, `INSERT INTO ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5)`,
		serviceID, tenantID, string(prefix), hash[:], user)
	return key, tenantID, serviceID
}

func exec(t *testing.T, db *pgx.Conn, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(context.Background(), q, args...); err != nil {
		t.Fatal(err)
	}
}

func randomText(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)[:n]
}

func flip(c byte) string {
	if c == 'A' {
		return "B"
	}
	return "A"
}

func pmetricotlpRequest(md pmetric.Metrics) ([]byte, error) {
	return pmetricotlp.NewExportRequestFromMetrics(md).MarshalProto()
}
