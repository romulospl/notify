package pgexporter

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.uber.org/zap"

	"github.com/romulospl/stellytics/services/collector/components/httpmetrics"
	"github.com/romulospl/stellytics/services/internal/pgtest"
)

// flaky fails on the first n writes and keeps the batches received.
type flaky struct {
	n       int
	batches []httpmetrics.Batch
}

func (f *flaky) write(_ context.Context, b httpmetrics.Batch) error {
	f.batches = append(f.batches, b)
	if len(f.batches) <= f.n {
		return errors.New("database down")
	}
	return nil
}

func batch() httpmetrics.Batch {
	k := httpmetrics.Key{Bucket: time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC), TenantID: "t", ServiceID: "s", Route: "/x", Method: "GET", Status: 200}
	return httpmetrics.Batch{k: &httpmetrics.Point{Count: 1, Sum: 0.01, Buckets: [httpmetrics.NumBuckets]int64{1: 1}}}
}

func TestSaveRetriesTheSameBatch(t *testing.T) {
	w := &flaky{n: 2}
	e := &pgExporter{logger: zap.NewNop(), w: w}
	b := batch()
	if err := e.save(context.Background(), b); err != nil {
		t.Fatalf("save = %v", err)
	}
	if len(w.batches) != 3 {
		t.Fatalf("attempts = %d, want 3", len(w.batches))
	}
	for _, got := range w.batches {
		if len(got) != 1 || got[mapKey(b)] != b[mapKey(b)] {
			t.Fatal("the retry did not rewrite the same batch")
		}
	}
}

func TestSaveGivesUpWithPermanentError(t *testing.T) {
	w := &flaky{n: 100}
	e := &pgExporter{logger: zap.NewNop(), w: w}
	err := e.save(context.Background(), batch())
	if !consumererror.IsPermanent(err) {
		t.Fatalf("err = %v, want permanent (the batch cannot be recomputed)", err)
	}
	if len(w.batches) != 4 {
		t.Errorf("attempts = %d, want 4", len(w.batches))
	}
}

func mapKey(b httpmetrics.Batch) httpmetrics.Key {
	for k := range b {
		return k
	}
	return httpmetrics.Key{}
}

// Real upsert into api_metric_1m as stellytics_collector. Needs DATABASE_URL
// (see internal/pgtest); COLLECTOR_DATABASE_URL replaces the collector's connection.
func TestPGWriterIntegration(t *testing.T) {
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

	tenantID, serviceID := pgtest.NewUUID(t), pgtest.NewUUID(t)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM api_metric_1m WHERE tenant_id = $1`, tenantID)
	})

	pool, err := pgxpool.New(ctx, pgtest.RoleURL(t, adminURL, "stellytics_collector", "COLLECTOR_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	w := pgWriter{pool: pool}

	minute := time.Now().UTC().Truncate(time.Minute)
	k := httpmetrics.Key{Bucket: minute, TenantID: tenantID, ServiceID: serviceID, Route: "/ledgers/{id}", Method: "GET", Status: 200}
	other := k
	other.Route, other.Status = "/health", 500
	first := httpmetrics.Batch{
		k:     {Count: 2, Sum: 0.03, Buckets: [httpmetrics.NumBuckets]int64{2: 2}},
		other: {Count: 1, Sum: 0.001, Buckets: [httpmetrics.NumBuckets]int64{0: 1}},
	}
	second := httpmetrics.Batch{k: {Count: 3, Sum: 6, Buckets: [httpmetrics.NumBuckets]int64{11: 3}}}
	for _, b := range []httpmetrics.Batch{first, second} {
		if err := w.write(ctx, b); err != nil {
			t.Fatal(err)
		}
	}

	var count int64
	var sum float64
	var buckets []int64
	var p95 float64
	err = admin.QueryRow(ctx, `
		SELECT request_count, duration_sum, duration_buckets, api_metric_quantile(duration_buckets, 0.95)
		FROM api_metric_1m WHERE tenant_id = $1 AND route = '/ledgers/{id}'`, tenantID).Scan(&count, &sum, &buckets, &p95)
	if err != nil {
		t.Fatal(err)
	}
	if count != 5 || sum != 6.03 || buckets[2] != 2 || buckets[11] != 3 {
		t.Errorf("summed row = %d, %v, %v", count, sum, buckets)
	}
	if p95 <= 2.5 || p95 > 5 {
		t.Errorf("p95 = %v, want within (2.5, 5]", p95)
	}
	var rows int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM api_metric_1m WHERE tenant_id = $1`, tenantID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Errorf("tenant rows = %d, want 2", rows)
	}
}
