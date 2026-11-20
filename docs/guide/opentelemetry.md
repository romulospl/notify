# OpenTelemetry

Send your API's HTTP metrics to stellytics next to the monitoring you already have.

## What to send

- **Endpoint:** `https://<collector>`, OTLP over HTTP (`/v1/metrics`) or gRPC.
- **Header:** `Authorization: Bearer ntf_<your-ingest-key>`.
- **Metric:** the `http.server.request.duration` histogram, with the SDK's default buckets. HTTP server spans also work, but sampled traces undercount.
- **Attributes:** `http.request.method`, `http.response.status_code` and, if your framework knows it, `http.route`.
- **Temporality:** prefer delta.

The ingest key decides which project and service the data belongs to. Any `service.name` or project attribute you send is ignored.

## With the SDK (Node.js)

Add a second metric reader to your `MeterProvider`:

```js
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const reader = (url, headers = {}) =>
  new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url, headers, temporalityPreference: AggregationTemporality.DELTA }),
  });

const provider = new MeterProvider({
  readers: [
    reader("https://apm.example.com/v1/metrics"), // your current backend
    reader("https://<collector>/v1/metrics", { Authorization: `Bearer ${process.env.STELLYTICS_INGEST_KEY}` }),
  ],
});
```

Other languages work the same way: two OTLP exporters, one with the `Authorization` header.

## With the OpenTelemetry Collector

Add one exporter and list it in your metrics pipeline:

```yaml
exporters:
  otlp_http/stellytics:
    endpoint: https://<collector>
    headers:
      Authorization: Bearer ${env:STELLYTICS_INGEST_KEY}

service:
  pipelines:
    metrics:
      exporters: [your_apm, otlp_http/stellytics]
```

Use the base URL here: the exporter adds `/v1/metrics` itself. Collector versions before v0.164.0 call the exporter `otlphttp`.

## What is kept

Only route, method, status, count and the latency distribution, per minute. Traces, spans and logs are never stored.

## Keys

- Each service can have up to 5 active keys. A key cannot be shown again, so keep it in a secrets manager.
- To rotate: get a new key, update your API, then have the old one revoked.
- A revoked key stops working within a minute.

A runnable example is in [`examples/api-backend`](../../examples/api-backend/README.md).
