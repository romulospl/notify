# OpenTelemetry

Send your Node.js API's HTTP metrics to stellytics next to the monitoring you already have.

## Requirements

- **Node.js 22.15 or newer**, the minimum of the OpenTelemetry JS packages below.
- An ingest key (`ntf_...`) and the collector address (`<collector>`).

## What stellytics reads

- **Endpoint:** `https://<collector>/v1/metrics` (OTLP over HTTP).
- **Header:** `Authorization: Bearer ntf_<your-ingest-key>`.
- **Metric:** the `http.server.request.duration` histogram, in seconds, with the default buckets. The HTTP instrumentation below emits it.
- **Attributes:** `http.request.method`, `http.response.status_code` and, when known, `http.route`. Without `http.route`, the path is [normalized](route-normalization.md).
- **Temporality:** delta.

The ingest key decides which project and service the data belongs to. Any `service.name` or project attribute you send is ignored.

## Install

```bash
npm install --save-exact @opentelemetry/sdk-node@0.300.0 @opentelemetry/instrumentation-http@0.300.0 @opentelemetry/exporter-metrics-otlp-proto@0.300.0 @opentelemetry/sdk-metrics@3.0.0
```

## Instrument your server

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

## Record it yourself

If you prefer not to use the instrumentation, create the histogram with a `MeterProvider` and record each request's duration, method, status and route. [`examples/api-backend`](../../examples/api-backend/README.md) is a runnable Node.js service that does exactly this, with dual export.

## Already running an OpenTelemetry Collector?

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

Here use the base URL: the Collector's exporter adds `/v1/metrics` itself. Collector versions before v0.164.0 call the exporter `otlphttp`.

## What is kept

Only route, method, status, count and the latency distribution, per minute. Traces, spans and logs are never stored.

## Keys

- Each service can have up to 5 active keys. A key cannot be shown again, so keep it in a secrets manager.
- To rotate: get a new key, update your API, then have the old one revoked.
- A revoked key stops working within a minute.
