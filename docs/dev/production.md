# Production infrastructure

Step by step in `docs/deploy.md`; overview in `docs/arquitetura.md` (update it when a component or production changes).

## Hetzner path (#14, ADR 0004)

- Hetzner Cloud (`nbg1`), **OpenTofu** in `infra/opentofu/` (not Terraform: BUSL license), Ansible in `infra/ansible/` (only `ansible.builtin`), `infra/compose/prod.yaml` with Caddy (`infra/caddy/Caddyfile`) and Debian Postgres with WAL-G (`infra/compose/postgres/Dockerfile`, `stellytics-backup`, `stellytics-restore`).
- The CI `infra` job validates the IaC and runs `infra/compose/test/prod-stack-test.sh` (Caddy routes, ports, encrypted backup and restore with local S3).
- A new service goes into `prod.yaml` and, if public, into the Caddyfile; Umami never.
- The collector and rollup are in `prod.yaml` without published ports: OTLP (HTTP and gRPC) goes out through Caddy on `API_HOST`, port 443, and the collector has a memory cap `COLLECTOR_MEM_LIMIT` (ADR 0012). `prod-stack-test.sh` sends a metric through the public host and checks `api_metric_1m`.
- Dockerfiles need BuildKit (`--mount`, `COPY --chmod`).
- Administration through the tunnel `infra/scripts/admin-tunnel.sh`.
- Mount folders, not files, in containers: Ansible replaces files by renaming.
- To run OpenTofu locally use the container `ghcr.io/opentofu/opentofu:1.13.2` (the name `tofu` clashes with rtk in the shell).

## Other paths

- Minimal VPS path: `infra/compose/prod-vps.yaml` (#159), described in `docs/deploy.md`.

## Monitoring (#15, ADR 0005)

`infra/monitoring/` (Prometheus, blackbox, Alertmanager) on a separate VM in `fsn1`, deployed by `infra/ansible/monitoring.yml`; tested by the `monitoring` job (`infra/monitoring/test/monitoring-test.sh`).

## Availability, load and handover (#51, #52, #54)

- Load: `docs/relatorios/carga-1m-dia.md` (tool in `services/loadtest/`, which refuses a remote target without `-allow-remote`; measured only on a local machine).
- HA: `docs/adr/0009-alta-disponibilidade.md` and `docs/sla.md` (the current architecture does not sustain 99.99%). OpenTofu `ha_*` variables are off by default; ingestion replica and Postgres standby in `infra/compose/prod-ingest.yaml`, `prod-standby.yaml` and `prod-ha-primary.yaml`, with manual failover in `docs/runbooks/failover-do-banco.md`, all off by default.
- Handover: `docs/transferencia.md` with `infra/scripts/db-export|db-import|db-fingerprint.sh` (import deletes databases: needs `--yes`, refuses a target with tenants and validates dumps before any `DROP`).

## Runbooks (#53)

`docs/runbooks/` (incidents, backup and restore, secret rotation, Umami upgrade, vulnerabilities), each with a "Not tested" section: nothing was exercised in real production. `walg_libsodium_key` cannot be rotated; SSH key rotation requires adding the new key to the VMs first, because OpenTofu ignores `ssh_keys`.
