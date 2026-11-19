# infra

Infrastructure rebuildable from this repository: one VPS with Docker Compose for production and a separate host for monitoring ([ADR 0016](../docs/adr/0016-producao-em-vps.md)). Step by step in [`docs/deploy.md`](../docs/deploy.md); the install scripts are `init.sh` and `deploy.sh` at the repository root.

| Folder | Tool | Role |
|---|---|---|
| [`compose/`](compose/) | Docker Compose | Local environment ([#12](https://github.com/romulospl/stellytics/issues/12)), included by the root `compose.yaml`, and production (`prod.yaml`) |
| [`compose/postgres/`](compose/postgres/) | Postgres + WAL-G | Database creation scripts and, in production, the image with continuous backup to S3-compatible storage (`Dockerfile`, `stellytics-backup`, `stellytics-restore`) |
| [`compose/test/`](compose/test/) | Docker Compose | Production stack test with a local S3 (`prod-stack-test.sh`, CI `infra` job) and data migration between operators (`data-migration-test.sh`, outside CI) |
| [`caddy/`](caddy/) | Caddy | Container proxy and automatic TLS |
| [`scripts/`](scripts/) | SSH, Postgres, Python | Admin tunnel to the production Postgres and Umami; export, import and fingerprint of the databases for handover ([`docs/transferencia.md`](../docs/transferencia.md)); helpers used by `init.sh` and `deploy.sh`, including the per-minute stack check (`stack-check.py`) |
| [`monitoring/`](monitoring/) | Prometheus, blackbox, Alertmanager | External monitoring on a separate host, configured by `configure.sh`: probes the portal, ingestion and the VPS stack check from outside and alerts by email ([#15](https://github.com/romulospl/stellytics/issues/15), [ADR 0005](../docs/adr/0005-monitoramento-externo.md)) |

## Umami only on the internal network

Umami must not be reachable from outside ([#62](https://github.com/romulospl/stellytics/issues/62), [docs/umami.md](../docs/umami.md)): anyone reaching its `/api/send` would bypass the gateway's anti-bot and IP truncation.

- The `umami` service publishes no port in any Compose file used for deployment. `compose/umami-port.yaml` publishes on `127.0.0.1` and is for development and CI only.
- **Caddy has no route to Umami**, neither UI nor API. It publishes only the `ingest-web` gateway (`/e`, `/c`, `/s/` and `/healthz`), the stack check status (`/healthz/stack`, answered by Caddy itself from `STELLYTICS_DATA_DIR/status`), the portal and the collector's OTLP routes. Checked on every PR by `compose/test/prod-stack-test.sh`.
- Caddy is the only service with public ports; upstreams talk only over the internal Docker network.
- The VPS firewall (set at the provider) opens only 22, 80 and 443. To administer Umami, use the SSH tunnel (`scripts/admin-tunnel.sh`).
