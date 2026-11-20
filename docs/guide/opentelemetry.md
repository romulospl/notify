# OpenTelemetry

Send your API's HTTP metrics to stellytics next to the monitoring you already have. Any language with an OpenTelemetry SDK works, or an OpenTelemetry Collector in front of your API.

## Requirements

- An API that exports OpenTelemetry metrics over OTLP, from any language's SDK or through an OpenTelemetry Collector.
- An ingest key (`ntf_...`) and the collector address (`<collector>`).

## What stellytics reads

- **Endpoint:** `https://<collector>/v1/metrics` (OTLP over HTTP), or `<collector>:443` (OTLP over gRPC).
- **Header:** `Authorization: Bearer ntf_<your-ingest-key>`.
- **Metric:** the `http.server.request.duration` histogram, in seconds, with the SDK's default explicit buckets. The standard HTTP server instrumentation of each SDK emits it. HTTP server spans also work, but sampled traces undercount.
- **Attributes:** `http.request.method`, `http.response.status_code` and, when known, `http.route`. Without `http.route`, the path is [normalized](route-normalization.md); set it in your own middleware when you want exact routes.
- **Temporality:** delta.

The ingest key decides which project and service the data belongs to. Any `service.name` or project attribute you send is ignored.

## Dual export

Keep your current exporter and add a second one for stellytics, with the `Authorization` header. The idea is the same in every language: two OTLP metric exporters on one meter provider. The standard `OTEL_EXPORTER_OTLP_*` variables configure a single destination, so the second one is set in code, or in a Collector.

## Example: Node.js

These package versions need Node.js 22.15 or newer.

```bash
npm install --save-exact @opentelemetry/sdk-node@0.300.0 @opentelemetry/instrumentation-http@0.300.0 @opentelemetry/exporter-metrics-otlp-proto@0.300.0 @opentelemetry/sdk-metrics@3.0.0
```

Create `instrumentation.mjs`. It measures every request your HTTP server handles (Express, Fastify and `node:http` all run on it) and sends the metric to two places: your current backend and stellytics.

```js
import { NodeSDK } from "@opentelemetry/sdk-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { AggregationTemporality, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const reader = (url, headers = {}) =>
  new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url, headers, temporalityPreference: AggregationTemporality.DELTA }),
  });

new NodeSDK({
  instrumentations: [new HttpInstrumentation()],
  metricReaders: [
    reader("https://apm.example.com/v1/metrics"), // your current backend; remove if you have none
    reader("https://<collector>/v1/metrics", { Authorization: `Bearer ${process.env.STELLYTICS_INGEST_KEY}` }),
  ],
}).start();
```

Load it before your app, so the HTTP module is instrumented from the first request:

```bash
STELLYTICS_INGEST_KEY=ntf_... node --import ./instrumentation.mjs server.js
```

Use the full URL, ending in `/v1/metrics`: the exporter does not add the path when you pass `url`.

To skip the instrumentation, create the histogram with a `MeterProvider` and record each request's duration, method, status and route yourself. [`examples/api-backend`](../../examples/api-backend/README.md) is a runnable Node.js service that does exactly this, with dual export.

## Example: OpenTelemetry Collector

For any language, if your API already sends to a Collector, add one exporter and list it in your metrics pipeline:

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

Here use the base URL: the Collector's exporter adds `/v1/metrics` itself. Collector versions before v0.164.0 call the exporter `otlphttp`.

## What is kept

Only route, method, status, count and the latency distribution, per minute. Traces, spans and logs are never stored.

## Keys

- Each service can have up to 5 active keys. A key cannot be shown again, so keep it in a secrets manager.
- To rotate: get a new key, update your API, then have the old one revoked.
- A revoked key stops working within a minute.
