// Package pgexporter writes the API metrics to Postgres (#31).
//
// It receives traces and metrics already stamped by tenantattr, extracts the
// 1-minute points with the httpmetrics package and upserts into api_metric_1m
// (E5 spec, section 4) with the stellytics_collector user. Nothing besides
// these points is written: no trace, span, log or high-cardinality attribute.
package pgexporter

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/configretry"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap"

	"github.com/romulospl/stellytics/services/collector/components/httpmetrics"
)

// Type is the exporter's name in the collector configuration.
var Type = component.MustNewType("stellyticspg")

// Config of the exporter.
type Config struct {
	// DatabaseURL points to the stellytics database with the stellytics_collector user.
	DatabaseURL string `mapstructure:"database_url"`
}

// Validate implements component.ConfigValidator.
func (c *Config) Validate() error {
	if c.DatabaseURL == "" {
		return errors.New("database_url is required")
	}
	return nil
}

// NewFactory creates the exporter's factory.
func NewFactory() exporter.Factory {
	return exporter.NewFactory(Type, func() component.Config { return &Config{} },
		exporter.WithTraces(createTraces, component.StabilityLevelDevelopment),
		exporter.WithMetrics(createMetrics, component.StabilityLevelDevelopment),
	)
}

// A single exporter per configuration, shared by the traces and metrics
// pipelines: D9 (metric takes priority over span) needs the same state.
var shared = map[*Config]*pgExporter{}

func get(set exporter.Settings, cfg *Config) *pgExporter {
	if e, ok := shared[cfg]; ok {
		return e
	}
	e := &pgExporter{cfg: cfg, logger: set.Logger, agg: httpmetrics.New()}
	shared[cfg] = e
	return e
}

func createTraces(ctx context.Context, set exporter.Settings, cfg component.Config) (exporter.Traces, error) {
	e := get(set, cfg.(*Config))
	return exporterhelper.NewTraces(ctx, set, cfg, e.pushTraces, e.options()...)
}

func createMetrics(ctx context.Context, set exporter.Settings, cfg component.Config) (exporter.Metrics, error) {
	e := get(set, cfg.(*Config))
	return exporterhelper.NewMetrics(ctx, set, cfg, e.pushMetrics, e.options()...)
}

// writer writes a batch. The Postgres one is pgWriter; the tests use another.
type writer interface {
	write(ctx context.Context, b httpmetrics.Batch) error
}

type pgExporter struct {
	cfg    *Config
	logger *zap.Logger
	agg    *httpmetrics.Aggregator

	started int // how many pipelines called Start
	pool    *pgxpool.Pool
	w       writer
	stop    context.CancelFunc
}

// The retries live here, over the already computed batch: recomputing from
// the OTLP would give a zero delta for the cumulative series. That is why the
// exporterhelper retry is turned off.
func (e *pgExporter) options() []exporterhelper.Option {
	return []exporterhelper.Option{
		exporterhelper.WithStart(e.start),
		exporterhelper.WithShutdown(e.shutdown),
		exporterhelper.WithCapabilities(consumer.Capabilities{MutatesData: false}),
		exporterhelper.WithRetry(disabledRetry()),
	}
}

func (e *pgExporter) start(ctx context.Context, _ component.Host) error {
	e.started++
	if e.started > 1 {
		return nil
	}
	pool, err := pgxpool.New(ctx, e.cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("stellyticspg: database_url: %w", err)
	}
	e.pool = pool
	e.w = pgWriter{pool: pool}
	sweepCtx, cancel := context.WithCancel(context.Background())
	e.stop = cancel
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-sweepCtx.Done():
				return
			case <-t.C:
				e.agg.Sweep()
			}
		}
	}()
	return nil
}

func (e *pgExporter) shutdown(context.Context) error {
	e.started--
	if e.started > 0 {
		return nil
	}
	if e.stop != nil {
		e.stop()
	}
	if e.pool != nil {
		e.pool.Close()
	}
	for cfg, x := range shared {
		if x == e {
			delete(shared, cfg)
		}
	}
	return nil
}

func (e *pgExporter) pushTraces(ctx context.Context, td ptrace.Traces) error {
	return e.save(ctx, e.agg.Traces(td))
}

func (e *pgExporter) pushMetrics(ctx context.Context, md pmetric.Metrics) error {
	return e.save(ctx, e.agg.Metrics(md))
}

// save writes the batch with up to 4 attempts. If all fail, the batch is
// dropped with a permanent error, so that nobody recomputes from the OTLP.
func (e *pgExporter) save(ctx context.Context, b httpmetrics.Batch) error {
	if len(b) == 0 {
		return nil
	}
	var err error
	for attempt, wait := 0, 200*time.Millisecond; attempt < 4; attempt, wait = attempt+1, wait*2 {
		if err = e.w.write(ctx, b); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			attempt = 4
		case <-time.After(wait):
		}
	}
	e.logger.Error("API metrics batch dropped", zap.Int("rows", len(b)), zap.Error(err))
	return consumererror.NewPermanent(err)
}

// upsert adds the point to the row, if it already exists (spec, section 4).
const upsert = `
INSERT INTO api_metric_1m AS m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                                request_count, duration_sum, duration_buckets)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tenant_id, api_service_id, route, method, status_code, bucket_start) DO UPDATE SET
  request_count = m.request_count + EXCLUDED.request_count,
  duration_sum = m.duration_sum + EXCLUDED.duration_sum,
  duration_buckets = api_metric_add_buckets(m.duration_buckets, EXCLUDED.duration_buckets)`

type pgWriter struct{ pool *pgxpool.Pool }

// write writes the batch in one transaction, in a fixed key order, so that two
// concurrent batches do not deadlock each other.
func (w pgWriter) write(ctx context.Context, b httpmetrics.Batch) error {
	keys := make([]httpmetrics.Key, 0, len(b))
	for k := range b {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, compareKeys)

	return pgx.BeginFunc(ctx, w.pool, func(tx pgx.Tx) error {
		batch := &pgx.Batch{}
		for _, k := range keys {
			p := b[k]
			batch.Queue(upsert, k.Bucket, k.TenantID, k.ServiceID, k.Route, k.Method, k.Status,
				p.Count, p.Sum, p.Buckets[:])
		}
		return tx.SendBatch(ctx, batch).Close()
	})
}

func compareKeys(a, b httpmetrics.Key) int {
	return cmpChain(
		strings.Compare(a.TenantID, b.TenantID),
		strings.Compare(a.ServiceID, b.ServiceID),
		strings.Compare(a.Route, b.Route),
		strings.Compare(a.Method, b.Method),
		int(a.Status)-int(b.Status),
		a.Bucket.Compare(b.Bucket),
	)
}

func cmpChain(cmps ...int) int {
	for _, c := range cmps {
		if c != 0 {
			return c
		}
	}
	return 0
}

func disabledRetry() configretry.BackOffConfig {
	c := configretry.NewDefaultBackOffConfig()
	c.Enabled = false
	return c
}
