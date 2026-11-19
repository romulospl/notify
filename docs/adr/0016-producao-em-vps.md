# 0016. Production on a single VPS, without high availability

- **Status:** Accepted
- **Date:** 19/11/2026
- **Issue:** #52

## Context

The repository had two production paths: the Hetzner path (OpenTofu, Ansible, `prod.yaml` with WAL-G, ADR 0004) and a minimal VPS path (`init.sh`, `deploy.sh`, `prod-vps.yaml`, #156–#159) without external backup. On top of the Hetzner path sat high-availability pieces (ADR 0009): extra ingestion VMs, a Postgres standby, a floating IP, a replication monitor and their tests, all off by default and never used. The production that will actually run is a VPS with Docker.

The RFP asks for hosting with targets that "proposers compete on" (99.99% ingestion, 99.90% dashboards; section 3.4), full infrastructure-as-code in the monorepo, a monitoring and alerting baseline (section 5), and a handover where "infrastructure can be rebuilt from the open-source monorepo". It does not require high availability, a specific provider or a provisioning tool. `CLAUDE.md` limits the project to what the RFP asks for.

## Decision

- Production is one VPS with Docker Compose: `init.sh` prepares the host and `.env.production`, and `deploy.sh` builds and starts `infra/compose/prod.yaml`. `prod-vps.yaml` is merged into `prod.yaml`.
- Postgres keeps the continuous WAL-G backup of ADR 0004, now to any S3-compatible storage (`WALG_S3_*`), with a daily base backup by a systemd timer installed by `deploy.sh`.
- OpenTofu and Ansible are removed. The provider and region are the operator's choice and must be declared (privacy, data residency).
- All high-availability pieces are removed. ADR 0009 is rejected: the availability targets are reported as targets, not sustained by the architecture.
- External monitoring (ADR 0005) stays on a separate host, configured by `infra/monitoring/configure.sh` and started with Docker Compose.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Keep both paths | No removal work | Two production paths to document, test and hand over; only one is used |
| Keep the Hetzner path only | Provisioning and deploy fully automated | Ties production to one provider; the production that will run is a VPS |
| Keep HA, off by default | Ready if a higher target is promised | About 1,200 lines and a Go service nobody runs; not required by the RFP |

## Consequences

- Rebuilding production is: a Debian/Ubuntu VPS, DNS, an S3 bucket, `init.sh`, edit `.env.production`, `deploy.sh` (`docs/deploy.md`).
- Creating the VPS, firewall (22, 80, 443) and bucket is manual; nothing provisions them.
- Images are built from the checkout by default; the signed release images can be used through `PORTAL_IMAGE` and the other image variables, but `deploy.sh` does not verify signatures.
- A VPS or disk failure means downtime until a new VPS is restored from the backup (`docs/runbooks/backup-e-restauracao.md`); 99.99% is not sustained.
- Supersedes the hosting and provisioning parts of ADR 0004 (the WAL-G backup is kept), the Ansible deploy of ADR 0014 and the deploy of the monitoring host in ADR 0005 (the monitoring itself is kept). ADR 0009 is rejected.
