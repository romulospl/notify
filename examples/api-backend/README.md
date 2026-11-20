# api-backend

Example HTTP backend (Node, no framework) instrumented with OpenTelemetry, and a **dual-export** guide: the API keeps sending its telemetry to the project's own APM and sends the same thing to the stellytics collector (#35). The collector contract is in [`docs/specs/e5-api-pipeline.md`](../../docs/specs/e5-api-pipeline.md).

`server.mjs` measures each request in the `http.server.request.duration` histogram (seconds, OTel semantic conventions), with `http.request.method`, `http.response.status_code` and `http.route` (or `url.path`, when the route has no known pattern; the collector normalizes it). Routes: `/accounts/<G...>`, `/accounts/<G...>/payments`, `/ledgers/<n>`, `/healthz` and `/fail` (500); everything else answers 404.

| Variable | What for |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP base of the tenant's own backend (APM or the tenant's OTel Collector) |
| `STELLYTICS_OTLP_ENDPOINT` and `STELLYTICS_INGEST_KEY` | OTLP/HTTP base of the stellytics collector and the `ntf_...` key; with both, the SDK does the dual-export by itself |
| `OTEL_SERVICE_NAME` | `service.name` (stellytics ignores it: the service comes from the key) |
| `PORT`, `EXPORT_INTERVAL_MS` | Port (default 4010) and export interval (default 10 s) |

## What stellytics needs to receive

- **Endpoint:** OTLP/HTTP (`/v1/metrics`, `/v1/traces`) or OTLP/gRPC of the stellytics collector. In the local Compose, `http://127.0.0.1:4318` (HTTP) and `127.0.0.1:4317` (gRPC).
- **Key:** `Authorization: Bearer ntf_...`, created under **Services** in the portal. The key defines the project and the service; attributes sent by the client do not change that. One key per service.
- **Signal:** the `http.server.request.duration` metric (preferred) or HTTP server spans. If the service sends both, stellytics uses the metric and ignores the spans, so as not to count twice. Logs and everything else are dropped at the collector.
- **Temporality:** prefer **delta**. Cumulative also works (the collector converts it), but a collector restart may lose one interval.
- **Privacy:** stellytics only reads route, method, status and duration. Even so, do not send personal data in attributes: the safest filter is the one that runs on your side (see the Collector below).

## Dual-export through the SDK

Each destination is a `PeriodicExportingMetricReader` with its own exporter, in the same `MeterProvider`. This is what `server.mjs` does:

```js
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const reader = (url, headers = {}) =>
  new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url, headers, temporalityPreference: AggregationTemporality.DELTA }),
  });

const provider = new MeterProvider({
  readers: [
    reader("https://apm.example.com/v1/metrics"), // own backend
    reader("https://<stellytics-collector>/v1/metrics", { Authorization: `Bearer ${process.env.STELLYTICS_INGEST_KEY}` }),
  ],
});
```

For traces, the same applies with two `BatchSpanProcessor`s in the `TracerProvider`. In other languages the idea is the same: two OTLP exporters, one with the `Authorization` header. The standard `OTEL_EXPORTER_OTLP_*` variables configure a single destination; the second one has to be set up in code, or use the Collector.

To run it on the host, with Compose up and a key created in the portal:

```bash
cd examples/api-backend
STELLYTICS_OTLP_ENDPOINT=http://127.0.0.1:4318 STELLYTICS_INGEST_KEY=ntf_... pnpm start
curl http://127.0.0.1:4010/ledgers/1
```

## Dual-export through the OTel Collector

If the API already sends to its own OTel Collector, adding one exporter is enough. [`otelcol.yaml`](otelcol.yaml) receives OTLP from the app and sends the same data to the tenant's own backend (the `debug` exporter stands in for it) and to stellytics:

```yaml
exporters:
  otlp_http/stellytics:
    endpoint: ${env:STELLYTICS_OTLP_ENDPOINT}
    headers:
      Authorization: Bearer ${env:STELLYTICS_INGEST_KEY}

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug, otlp_http/stellytics] # replace debug with your APM's exporter
```

It works with the core Collector (`otel/opentelemetry-collector`) from v0.164.0 on; in older versions, the exporter name is `otlphttp`. With contrib, you can send stellytics only what is needed, for example a `filter` processor before `otlp_http/stellytics` in a separate pipeline.

## In Compose

The override [`infra/compose/api-example.yaml`](../../infra/compose/api-example.yaml) starts the app (port 4010) and the tenant's Collector (`tenant-otelcol`), which does the dual-export to the stellytics collector:

```bash
STELLYTICS_INGEST_KEY=ntf_... docker compose -f compose.yaml -f infra/compose/api-example.yaml up -d --wait
curl http://127.0.0.1:4010/accounts/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7
docker compose -f compose.yaml -f infra/compose/api-example.yaml logs tenant-otelcol   # "own APM"
```

The rows show up in `api_metric_1m` within a few seconds. [`compose-check.sh`](compose-check.sh) does all of this by itself (creates the tenant and key in the database, starts everything, makes requests, checks the rows and deletes) and runs in the CI `compose` job.
