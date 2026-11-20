// Example backend instrumented with OpenTelemetry (#35).
//
// Measures each request in the http.server.request.duration metric (histogram
// in seconds, OTel semantic conventions) and exports over OTLP/HTTP:
//   - to the tenant's own backend (APM or OTel Collector), in
//     OTEL_EXPORTER_OTLP_ENDPOINT;
//   - and, if STELLYTICS_OTLP_ENDPOINT and STELLYTICS_INGEST_KEY are set,
//     also to the stellytics collector (dual-export straight from the SDK).
// With neither of them, it only serves the routes.
import http from "node:http";
import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const port = Number(process.env.PORT ?? 4010);
const interval = Number(process.env.EXPORT_INTERVAL_MS ?? 10000);

// OTLP/HTTP base endpoint (without /v1/metrics).
function reader(endpoint, headers) {
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
      headers,
      // Delta is what stellytics recommends (E5 spec, section 2).
      temporalityPreference: AggregationTemporality.DELTA,
    }),
    exportIntervalMillis: interval,
  });
}

const readers = [];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  readers.push(reader(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, {}));
}
if (process.env.STELLYTICS_OTLP_ENDPOINT && process.env.STELLYTICS_INGEST_KEY) {
  readers.push(
    reader(process.env.STELLYTICS_OTLP_ENDPOINT, {
      Authorization: `Bearer ${process.env.STELLYTICS_INGEST_KEY}`,
    }),
  );
}

const provider = new MeterProvider({
  resource: resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME ?? "example-api-backend",
  }),
  readers,
});
metrics.setGlobalMeterProvider(provider);

const duration = provider
  .getMeter("example-api-backend")
  .createHistogram("http.server.request.duration", {
    unit: "s",
    description: "Duration of HTTP server requests.",
    advice: {
      // Boundaries recommended by the OTel conventions, the same as stellytics.
      explicitBucketBoundaries: [
        0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5,
        10,
      ],
    },
  });

// Routes with an already known pattern: http.route goes out ready, without IDs.
const routes = [
  { method: "GET", pattern: /^\/accounts\/([A-Z0-9]{56})$/, route: "/accounts/{account_id}" },
  { method: "GET", pattern: /^\/accounts\/([A-Z0-9]{56})\/payments$/, route: "/accounts/{account_id}/payments" },
  { method: "GET", pattern: /^\/ledgers\/(\d+)$/, route: "/ledgers/{sequence}" },
  { method: "GET", pattern: /^\/healthz$/, route: "/healthz" },
];

const server = http.createServer((req, res) => {
  const start = performance.now();
  const path = (req.url ?? "/").split("?")[0];
  const match = routes.find((r) => r.method === req.method && r.pattern.test(path));

  let status = 404;
  let body = { error: "not found" };
  if (match) {
    status = 200;
    body = { ok: true, route: match.route };
  } else if (path === "/fail") {
    status = 500;
    body = { error: "boom" };
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));

  const attrs = {
    "http.request.method": req.method ?? "GET",
    "http.response.status_code": status,
  };
  // With no known pattern, the path goes out and the stellytics collector normalizes it.
  if (match) attrs["http.route"] = match.route;
  else attrs["url.path"] = path;
  duration.record((performance.now() - start) / 1000, attrs);
});

server.listen(port, () => {
  console.log(`example-api-backend on :${port}, ${readers.length} OTLP destination(s)`);
});

// Exports what is left before exiting.
async function stop() {
  server.close();
  await provider.shutdown();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
