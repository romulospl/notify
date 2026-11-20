# 0012. API ingestion in production through Caddy, on port 443

- **Status:** Restored by 0014
- **Date:** 16/11/2026
- **Issue:** #14 (production IaC), #30 and #34

## Context

The API collector (`services/collector`) and the rollup job (`services/rollup`) existed only in the development Compose. In production the portal allowed creating ingest keys, but nothing received OTLP: the `api_metric_*` tables stayed empty and retention did not run. What was missing was deciding where OTLP comes in. The ingest key is a bearer token, so the traffic needs TLS.

## Decision

The collector and the rollup go into `infra/compose/prod.yaml`, with no published port. OTLP goes out through Caddy, on a third host (`API_HOST`, `api_host` in Ansible), on port 443:

- OTLP/HTTP: `POST /v1/traces`, `/v1/metrics` and `/v1/logs` go to `collector:4318`;
- OTLP/gRPC: `POST` with `Content-Type: application/grpc*` on `/opentelemetry.proto.collector.*` goes to `collector:4317` over h2c;
- everything else answers 404.

The `collector` and `rollup` images are deployed by digest and go through Ansible's `cosign verify`, like those of the portal and the gateway. The collector container has a memory ceiling (`COLLECTOR_MEM_LIMIT`, default 512 MB), because the `memory_limiter` computes 80% over the memory it sees: without a ceiling, that would be the whole VM's. External monitoring tests the host with a POST without a key and expects the collector's 401 (blackbox module `otlp_401`).

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Caddy on 443, own host (chosen) | A single entry point; automatic TLS; firewall unchanged; HTTP and gRPC on the same endpoint | One more DNS record; Caddy becomes the single point for the API too |
| Publish 4317 and 4318 and open them in the firewall | Standard OTLP ports | The collector would have to terminate TLS (certificate outside Caddy); more exposed surface; firewall and OpenTofu change |
| Path on the web ingestion host (`INGEST_HOST`) | No new DNS | Mixes browser and server traffic; the host is chosen to escape ad blockers, not for SDKs; gRPC and the gateway's routes on the same host |

## Consequences

- Production needs a third DNS record (A and AAAA) before the deploy; without it Caddy cannot get the certificate for that host (the other two keep working).
- Whoever already has a production `.env` needs `API_HOST`, `COLLECTOR_IMAGE` and `ROLLUP_IMAGE`; `prod.yaml` does not start without them.
- Caddy does not limit requests per IP; the collector only has the key authentication and the `memory_limiter`. A per-key or per-tenant limit in the collector remains open.
- Tested only locally (`infra/compose/test/prod-stack-test.sh`: 401 without a key on HTTP and gRPC, 404 on the rest, metric written to the key's tenant, key absent from the logs). Never applied on a real account; the ingestion replicas (`prod-ingest.yaml`) still have only the web gateway.
