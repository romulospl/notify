# API pipeline: collector, metric tables and rollup

Contract in `docs/specs/e5-pipeline-de-api.md` (route normalization, tables, buckets, retention). Read it before any E5 issue (#30–#36).

## Collector (`services/collector`)

- Go components in `services/collector/components/`, one package per component.
- **Distribution (#30):** OCB manifest in `collector/builder-config.yaml` (Collector v0.164.0 / core v1.70.0). Generated code is committed in `collector/cmd/stellytics-collector` by `collector/generate.sh` (OCB creates its own `go.mod`; the script copies only the `.go` files into the `services` module). The CI `go` job regenerates and fails on any diff. All `go.opentelemetry.io/collector/...` modules move together, in the same release and with 14 days; beware `go mod tidy`, which pulls the newest. Config in `collector/config.yaml`.
- **Authentication (#30):** extension `components/ingestkeyauth`, `Authorization: Bearer ntf_...` over HTTP and gRPC, lookup by prefix in `ingest_key_active` as `stellytics_collector`, constant-time SHA-256, cache of at most 60 s (`INGEST_KEY_CACHE_TTL`). Refuses with 401 / Unauthenticated. The processor `components/tenantattr` (before `batch`) sets `stellytics.tenant.id` and `stellytics.api_service.id` from the key and deletes any client-sent attributes with those names. The full key never goes to logs.
- **Metrics (#31):** exporter `stellyticspg` (`components/pgexporter`) with extraction in `components/httpmetrics`: HTTP server spans and `http.server.request.duration` (or `http.server.duration` in ms) become 1-minute points in `api_metric_1m`; logs go to `nop`. D9: when the metric was seen in the last 15 min, the service's spans are ignored. Cumulative becomes delta in memory. Cap of 500 routes per service and day (`{other}`). The batch is computed once and rewritten; exporterhelper retry is off, because recomputing would give a zero delta.
- **Route normalization (#32):** `components/routenorm`, `Route(httpRoute, path)`. A client `http.route` is used as is; otherwise segments become `{uuid}`, `{address}` (StrKey G/C of 56 or M of 69 characters, checksum not verified), `{hash}` (16+ hex, with or without `0x`) or `{id}` (digits only), in that order. Strips query, fragment, repeated and trailing slashes; truncates at 256 bytes at a segment boundary. Fuzz test: `go test -fuzz FuzzPath ./collector/components/routenorm`, with found cases in `testdata/fuzz`.
- **Go tests with a database:** `services/internal/pgtest` provides a database with the portal migrations (temporary, with `CREATEDB`; otherwise the already migrated one) and never migrates the one in `DATABASE_URL`. Close the connection with `t.Cleanup`, not `defer`, so cleanups run first.

## Metric tables (database `stellytics`)

- Hand-written migration `apps/portal/drizzle/0004_api_metrics.sql` (#33), tested in `apps/portal/test/api-metrics.test.ts`.
- `api_metric_1m` (written by the collector), `api_metric_1h` and `api_metric_1d` (rollup): same columns, key `(tenant_id, api_service_id, route, method, status_code, bucket_start)`, partitioned by UTC month (`<table>_pYYYYMM`) with a `<table>_default` partition. `api_metric_ensure_partitions(months)` creates missing partitions and moves rows out of the default one.
- `duration_buckets` has 15 positions, with the bounds of `api_metric_bounds()` (OTel buckets for `http.server.request.duration`, in seconds, plus one above 10 s). Percentile: `api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.95)`; in `ON CONFLICT`, add with `api_metric_add_buckets`.
- `stellytics_collector` has `SELECT`, `INSERT` and `UPDATE` only on `api_metric_1m`.

## Rollup and retention (#34, `services/rollup`)

- Functions from migration `0005_api_metric_rollup.sql` (`api_metric_rollup`, `api_metric_drop_partitions`, `api_metric_maintain`, only for `stellytics`), tested in `apps/portal/test/api-metric-rollup.test.ts`.
- The service calls `api_metric_maintain` every `ROLLUP_INTERVAL` (15 min), redoing the last 48 h: 1h from 1m, 1d from 1h, only hours closed for 5 min, `ON CONFLICT` replacing (idempotent). After a failed run, retries in 30 s.
- Retention by `DROP TABLE` of the monthly partition: 35 days for 1m, 25 months for 1h and 1d.

## End to end (#36)

`examples/api-backend/compose-check.sh` (CI `compose` job) checks route, status, latency and tenant in `api_metric_1m`, sends a trace and a log claiming another tenant, and fails if the metric lands there or if the marker appears in any text column of the `stellytics` database.
