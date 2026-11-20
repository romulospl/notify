# services/collector

Own distribution of the OpenTelemetry Collector, built with the OCB (OpenTelemetry Collector Builder). Contract in [`docs/specs/e5-api-pipeline.md`](../../docs/specs/e5-api-pipeline.md).

- **Pipeline:** OTLP receiver (gRPC on 4317, HTTP on 4318) → `memory_limiter` → `tenantattr` → `batch` → `stellyticspg` (traces and metrics) or `nop` (logs).
- **Stores only counters and histograms** in `api_metric_1m`. Traces, spans and logs are never written (#31).

## Metrics (#31)

The `stellyticspg` exporter (`components/pgexporter`) uses the `components/httpmetrics` package to turn each batch into 1-minute points. It then writes the points to `api_metric_1m` with a summing `INSERT ... ON CONFLICT`, in one transaction and in a fixed key order.

- **Inputs:** HTTP server spans (`span.kind = SERVER` with a method) and the `http.server.request.duration` histogram (or the old `http.server.duration`, in ms). Everything else is dropped.
- **Attributes:** from each request only the normalized route (`routenorm`), method, status and duration are kept. The source buckets are mapped to the 15 in the database.
- **D9:** if the service sent the metric in the last 15 minutes, its spans are ignored. Metrics and traces go through separate batches, so on the first switch there may be double counting for one batch.
- **Cumulative:** `cumulative` points become deltas against the last value of each series, in memory. The first observation only counts if the process started at most 5 minutes ago.
- **Route cap (D4):** 500 routes per service and day; the excess becomes `{other}`. It is counted per collector instance.
- **Database failure:** the batch is computed once and rewritten up to 4 times. After that it is dropped with a permanent error, because recomputing from the OTLP would give a zero delta on the cumulative series.
- **Own components** in [`components/`](components/).

## Authentication (#30)

Every OTLP request needs `Authorization: Bearer ntf_<prefix>_<secret>` (E2 spec, section 5), over HTTP and over gRPC.

1. The `ingestkeyauth` extension looks the key up by prefix in the `ingest_key_active` view, as the `stellytics_collector` user, and compares the SHA-256 in constant time.
2. A key that is missing, malformed, wrong, revoked, of an archived service or of a tenant that is not active gets `401` (HTTP) or `Unauthenticated` (gRPC). The response is the same in all cases.
3. The answers, positive and negative, are cached for `INGEST_KEY_CACHE_TTL` (at most 60 s, 5 s in Compose). A revocation takes effect within that time. A database error is not cached.
4. The `tenantattr` processor erases from the resource what the client sent as tenant and writes `stellytics.tenant.id` and `stellytics.api_service.id` with the key's values. It comes before `batch`, which loses the request context. Data that arrives without authentication is refused there.
5. The full key never goes to a log; only the prefix.

## Generated code

The manifest is [`builder-config.yaml`](builder-config.yaml), with the core components of Collector v0.164.0 (core v1.70.0) and ours. The OCB always creates its own `go.mod`. Since ADR 0002 asks for a single Go module in `services/`, [`generate.sh`](generate.sh) generates into a temporary folder and copies only the `.go` files to `cmd/stellytics-collector`. After changing the manifest or the OCB version:

```bash
cd services && collector/generate.sh && go mod tidy
```

The `go` CI job checks that the generated code is committed. When bumping the Collector version, all `go.opentelemetry.io/collector/...` modules must move together, in the same release and at least 14 days old.

## Running

```bash
cd services && go build -o /tmp/stellytics-collector ./collector/cmd/stellytics-collector
DATABASE_URL=postgresql://stellytics_collector:stellytics_collector@127.0.0.1:5432/stellytics /tmp/stellytics-collector --config collector/config.yaml
```

In Compose, the `collector` service publishes 4317 and 4318 on `127.0.0.1`. The image is `scratch`; the container healthcheck is the `/healthcheck` binary, which sends a GET to the HTTP receiver.

## Tests

- `components/ingestkeyauth`: unit (format, cache, database error) and integration with the real view as `stellytics_collector` (needs `DATABASE_URL`; see `internal/pgtest`).
- `components/tenantattr`: includes `pipeline_test.go`, which starts the real OTLP receiver in process and checks HTTP and gRPC: refusal without a key, and tenant and service taken from the key, over what the client sent.
- `components/httpmetrics`: spans and histograms to points, bucket and ms remapping, cumulative to delta, D9, route cap.
- `components/pgexporter`: retry over the same batch and a real upsert into `api_metric_1m` as `stellytics_collector`.
- `e2e/` (tag `e2e`, CI job `compose`): against the container, with keys created in the database.
  - The valid key passes; the wrong one, the missing one and the one of a removed tenant are refused.
  - The metric of one service is written, and its spans are ignored (D9).
  - The spans of another service become a normalized route.
  - Logs and client spans leave nothing behind.
