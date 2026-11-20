# 0009. High availability for the SLA targets

- **Status:** Rejected (0016)
- **Date:** 15/11/2026
- **Issue:** [#52](https://github.com/romulospl/stellytics/issues/52)
- **Depends on:** [ADR 0002](0002-architecture-and-stack.md), [ADR 0004](0004-hosting-and-backup.md), [ADR 0005](0005-external-monitoring.md)

## Context

The RFP "Web and API Analytics for Stellar Ecosystem Projects" (`scf-web-api-analytics`) asks, in the hosting and delivery section, for **targets** of 99.99% availability on ingestion, 99.90% on the dashboards and a fix for critical and high vulnerabilities within 24 hours. Source: Stellar Light (`scout.getRfps`, through the stellar-raven MCP), checked on 15 November 2026; the text says "targets", not contractual obligations. The commitments the project takes on are in [`docs/sla.md`](../sla.md); this ADR decides the architecture that would support them and says, for each design, which target it actually supports.

### Error budget

| Target | 30-day window | 365-day window |
|---|---|---|
| 99.99% | 0.0001 x 43,200 min = **4.32 min** | 52.6 min |
| 99.90% | 0.001 x 43,200 min = **43.2 min** | 8.76 h |

Production today (ADR 0004) is **one VM in `nbg1`** with Caddy, the portal, the gateway, Umami and Postgres, a single volume, a single human operator and the monitor on another VM (`fsn1`, ADR 0005). Against the budget:

- The `EndpointDown` alert only fires after **1 minute** without a 2xx, with a probe every 15 s, and it arrives by email. Detection alone already spends at least 1 min 45 s of the 4.32 min (1 min of `for`, up to 15 s of probing and 30 s of Alertmanager `group_wait`, not counting SMTP), before any person acts.
- Recreating the VM from scratch (`docs/deploy.md`, steps 1 and 4) and, if the volume is lost, restoring the database takes much longer than 4 minutes. The restore time **has never been measured** in a real production (there is no real deploy yet).
- Every `docker compose up -d` of a new version restarts containers; with one VM, every deploy is an unavailability window of seconds to minutes (not measured).
- **One short incident per month is enough to blow 99.99%.** With one VM, the 99.99% target is unreachable by construction, not for lack of care.

### Real single points of failure (read from `infra/`, `docs/` and the ADRs)

| # | Point | Effect if it fails | Evidence |
|---|---|---|---|
| 1 | The `stellytics` VM (`hcloud_server.stellytics`) | Everything goes down: portal, ingestion, Umami, database | `infra/opentofu/main.tf`; ADR 0004 ("Single points of failure") |
| 2 | The `nbg1` data center and its network | Same, and the volume and the backup bucket are in the same location | ADR 0004 item 1 |
| 3 | The single Postgres and the data volume | Without the database: the portal goes down, Umami does not write, the gateway returns 503 when the `ingest_site` cache expires (up to 1 min), the collector rejects new keys after 60 s | `services/ingest-web/README.md`; CLAUDE.md |
| 4 | The single Umami | Without it, the gateway has nowhere to relay web events to | `prod.yaml` |
| 5 | The single Caddy (TLS, ACME) | No public entry point; a renewal failure brings everything down | `Caddyfile`; `TLSCertificateExpiringSoon` alert |
| 6 | Portal migrations at boot (`RUN_MIGRATIONS=true`) | A slow or failing migration keeps the portal down | `prod.yaml` |
| 7 | Manual deploy through Ansible, by one person | No pager; MTTR depends on one person being available | `docs/runbooks/README.md` ("today operations are run by one person only") |
| 8 | Single monitor in `fsn1`, a single vantage point, alerts by email | False positive or negative if the monitor's route fails; without an external sign of life, its own outage goes unnoticed | ADR 0005; optional `monitor_deadman_url` |
| 9 | DNS outside the IaC, provider not chosen | Changing the IP depends on the TTL and on manual action | ADR 0004 item 4 |
| 10 | External SMTP (`SMTP_URL`) | Sign-up and password recovery stop (not the dashboards or ingestion) | `prod.yaml` |
| 11 | GHCR and cosign at deploy time | A fix cannot be published if the registry is down (the running production is not affected) | `docs/runbooks/vulnerabilities.md` |
| 12 | The API collector and `rollup` **are not in production** | API ingestion does not exist in production today; the 99.99% target "on API ingestion" has nothing to measure | `docs/deploy.md`; empty `monitor_api_url` |
| 13 | Backup RPO/RTO: continuous WAL with an `archive_timeout` of 60 s gives an RPO of about 1 min, but the RTO is the restore time, not measured | Loss of the volume = hours of unavailability | ADR 0004 item 5 |

### What the code already helps with and what gets in the way

- **The JS proof is already stateless** across instances: the token is signed with HMAC (`PROOF_SECRET`); any replica validates the challenge issued by another, as long as they all use the same secret.
- **The gateway stores no data**: the `ingest_site` cache (at most 1 min) is only for performance.
- **The per-IP rate limit and the per-IP-and-site fingerprint limit are in memory, per instance** (`internal/limit`, `internal/fingerprint`). With N replicas and load balancing without IP affinity, the effective limit becomes up to N times the configured one, and the same IP can accumulate fingerprints on each replica. The portal's read limit (ADR 0006) has the same flaw. The Better Auth limit is probably in memory: the code does not configure `storage` (`src/lib/auth.ts`, `rateLimit` block).
- **The script has `keepalive: true` but does not resend** (`packages/tracker/src/tracker.ts`): an event sent during an outage is lost.
- **The collector has no retry** in the `stellyticspg` exporter (on purpose, because recomputing the delta would give zero) and the rollup is idempotent; a queue before the exporter would require rethinking this.
- **Migrations run at portal boot**; with several portal replicas, only one may run migrations.

## Decision

Adopt the architecture in **tiers**, each with the target it actually supports, and **implement only the first provisioning step** (OpenTofu variables off by default). The rest is planned and not promised.

1. **Tier 0 (today): one VM.** Supports, at best, a best-effort target, with no committed number. It does not support 99.99% and does not guarantee 99.9%.
2. **Tier 1: replicated ingestion.** Two or more ingestion VMs (web gateway and, when it exists in production, the collector, each with its own Caddy) in different locations of the same Hetzner network zone (`nbg1` and `fsn1`), behind a **Hetzner Load Balancer** with health checks (`/healthz`) or a reassigned floating IP. The database remains single. All replicas use the same `PROOF_SECRET`. The gateway starts to **serve the last value of the `ingest_site` cache when the database fails** (code change, not done). Supports, at best, **99.9% on ingestion**, limited by the single database and by the load balancer itself; **not** 99.99%.
3. **Tier 2: Postgres with a replica and failover.** Streaming replica (its own VM and volume, in another location), with manual promotion first and automatic later. Reliable automatic failover needs a witness (three nodes, or Patroni with etcd); with two nodes there is a risk of two primaries. Supports **99.9% on the dashboards** if the portal is also replicated (one instance runs migrations) and the failover is rehearsed. 99.99% would only be defensible with three database nodes, deploys without interruption, failover measured in seconds and a real measurement period; this is **not** promised in this ADR.
4. **Tier 3 (not adopted now): ingestion that tolerates the database being down, with a queue.** A disk buffer or queue before Umami and the collector would avoid losing events during a database outage. It requires a new component, because Umami writes straight to Postgres and the collector's exporter does not retry. It remains an alternative for when the database is the measured limiting factor.
5. **What the IaC creates now, off by default** (`infra/opentofu/`): `ha_ingest_replicas` (0 to 3 ingestion VMs in `ha_ingest_location`), `ha_floating_ip` (IPv4 floating IP pointed at the main VM), `ha_db_standby` (replica VM and volume in `ha_db_standby_location`) and a private network `10.50.0.0/16` created when any of them is on. With the defaults, the plan's `resource_changes` are identical to the previous ones and the `output_changes` only gain the three new outputs, empty (verified, see PR). This only **provisions**; it does not configure replication, Caddy on the replicas, load balancing or the floating IP inside the system. **Locations:** the standby and the ingestion VMs have a precondition against the main VM's location (`location`, `nbg1`); their defaults are `fsn1`, the same location as the monitor (`monitor_location`). On a failover to `fsn1`, the monitor is no longer independent of production (ADR 0005). The floating IP is IPv4 only: the AAAA record keeps pointing at the old VM and does not move on failover. New outputs in `outputs.tf`: `ingest_ipv4`, `floating_ipv4`, `standby_private_ip` (empty or null with the defaults). The Postgres replica uses the monitor's firewall (SSH and ping only) and the private network.
6. **Vulnerabilities:** the project commits to assessing possible critical and high ones within 48 hours and to fixing them within 7 calendar days (critical) and 14 (high); containment of critical ones in 72 h and the RFP's 24 h are targets, not commitments; the commitment and the exception for security fixes are in [`docs/sla.md`](../sla.md) and in the [runbook](../runbooks/vulnerabilities.md).

## Alternatives considered

Monthly costs are **order-of-magnitude estimates** made from memory, without checking the Hetzner price list on this date; confirm with `hcloud server-type list` and on the pricing page before deciding. There is no real VM to measure.

| Alternative | Pros | Cons | Extra monthly cost (estimate, not verified) | Target it supports |
|---|---|---|---|---|
| One VM (today) | Simple, cheap | All the single points above | 0 | None committed |
| 2+ ingestion VMs behind the Hetzner Load Balancer | Removes the VM as a single point for ingestion; deploys without interruption become possible | The database remains single; the load balancer in one location is a new single point; TLS (ACME with several VMs or a certificate on the load balancer) still to be solved; per-IP limits multiplied by N | About 5 to 15 EUR per extra VM and 5 to 10 EUR for the load balancer | Up to 99.9% on ingestion |
| Floating IP with manual or scripted reassignment | Cheap; fixed DNS | Failover is not automatic; switch time not measured; a single active Caddy | About 3 to 5 EUR | Improves the RTO, not the RPO or the target |
| Postgres with a replica and manual promotion | Losing the volume or the VM does not require restoring from the backup | Promotion depends on a person; two nodes without a witness | About 5 to 15 EUR (VM) plus 2 to 4 EUR (40 GB volume) | Dashboards at 99.9%, with caveats |
| Postgres with Patroni (3 nodes) | Automatic and safe failover | Three nodes, etcd, a lot of operations work for a single person; Umami and the portal need to reconnect | About 20 to 45 EUR | Necessary (not sufficient) condition for 99.99% |
| The provider's managed Postgres | Failover ready-made | Already ruled out in ADR 0004 (ties to the provider, leaves Compose) | Not estimated | Not assessed |
| Ingestion with a queue or buffer | Does not lose events with the database down | New component; Umami writes straight to the database; the collector's exporter has no retry | Not estimated | Protects data integrity, not the measured availability of the endpoint |
| Two regions or two providers | Survives the failure of one provider | Data in the EU (residency) limits the options; DNS with failover; high cost and complexity for the MVP | Not estimated | Needed for a true 99.99%; out of reach today |

**Total cost of tiers 1 and 2 together, estimate:** about 20 to 50 EUR per month above the current cost. Marked as an estimate; do not use it in a budget without checking the prices.

## Consequences

- **Honesty about the targets:** the project now treats 99.99% on ingestion and 99.90% on the dashboards as **RFP targets**, not as a commitment it takes on, until the corresponding tier is in production, with measurement and a failover rehearsal. See [`docs/sla.md`](../sla.md).
- **New variables in OpenTofu** (all off) and new resources only when they are on. Turning any of them on creates paid resources; `delete_protection` and `prevent_destroy` apply to the volumes and the floating IP.
- **Update (second part of #52):** the following now exist, off by default: `infra/ansible/ingest.yml` and `standby.yml` (roles `stellytics_ingest` and `postgres_standby`), the `ha_replication` variable of `site.yml`, the files `infra/compose/prod-ha-primary.yaml`, `prod-standby.yaml` and `prod-ingest.yaml`, the `Caddyfile.ingest` and the database failover runbook. Asynchronous streaming replication with a physical slot, **manual** promotion and the old primary rebuilt by `pg_basebackup`; the primary only gains a `replicator` role, a `pg_hba` line per network range, `max_slot_wal_keep_size` and ports on the private IP. Tested in local Docker by `infra/compose/test/ha-replication-test.sh` (replication, read-only, promotion, gateways reading from the promoted database, WAL-G after the promotion). The expected RPO and RTO are estimates (runbook). **Not** tested: private network, firewalls, Hetzner load balancer and floating IP, automatic failover, load.
- **Update (expired cache in the gateway):** the gateway now accepts `SITE_STALE_TTL` (default `0`, off; maximum `1h`). With the `ingest_site` query failing, it serves the last known response for the site for up to that long after it expired; a site never seen, unknown or rejected gets no stale value: within `SITE_CACHE_TTL` the rejected one still receives `204` (and the event is discarded), but past that deadline, during the failure, it goes back to `503` (same as the unknown one, so that the failure does not reveal which IDs the gateway knows); and there is a single in-flight query per site. **Decision and cost:** we trade event loss for a window of late rejection. A tenant removed or a site archived during the database outage keeps accepting events for up to `SITE_CACHE_TTL` + `SITE_STALE_TTL`, and only the return of the database applies the rejection. For web analytics, losing events in a short outage costs more than accepting a few events from a recently removed tenant, which exposes nobody's data. That is why the default is off and the choice of value belongs to the operator. Tested with an injected failure (Go tests) and with a real Postgres stopped in Docker. Accepted and rejected sites are kept in separate, bounded maps, and only an accepted site gets a stale value; a 2 s circuit breaker serves the expired value immediately when the database hangs. `prod.yaml` and `prod-ingest.yaml` (both start the gateway) do not pass the variable through yet (like `SITE_CACHE_TTL`): turning it on requires editing both.
- **Work that remains open** (without it, turning the variables on does not deliver HA):
  - Ansible: configuration of the floating IP on the VM's interface;
  - Postgres: decision on automatic failover (witness), and the portal and Umami still talk to the `postgres` of their own Compose (the supported failover moves the whole stack to the replica's VM);
  - Caddy: certificates with several VMs (HTTP-01 behind a load balancer is a problem; DNS-01 requires a module the image does not have) or termination at the load balancer;
  - gateway code: reassess the per-instance limits (divide `RATE_LIMIT` and `FINGERPRINT_LIMIT` by N or limit at the load balancer);
  - portal: a single instance with `RUN_MIGRATIONS=true`;
  - API ingestion: the collector and `rollup` still need to go into `prod.yaml`;
  - monitoring: probing from more than one vantage point, `monitor_api_url`, alerts on replication lag and backup age, a pager instead of email;
  - measure the restore and failover RTO in a rehearsal.
- **The load balancer in one location is a new single point**, unless more than one is used (not decided).
- **Not verified:** prices, the Hetzner SLA for VMs, volumes, floating IP and Load Balancer, the floating IP reassignment time, the Load Balancer's behaviour with health checks and IP affinity, and everything that depends on a real account.
