# Architecture decisions

The architecture decisions of stellytics (formerly ADRs), one short section each: what was decided and why. Numbers are stable, so code and docs can cite them ("decision 0003"). The full original records, with alternatives and discussion, are in the git history of `docs/adr/` (removed after commit 65030b0).

| No. | Decision | Status |
|---|---|---|
| [0001](#0001-base-tool) | Umami as the base tool | In force |
| [0002](#0002-architecture-and-stack) | Architecture and stack | In force; infrastructure tooling replaced by 0016 |
| [0003](#0003-portal-isolation) | The portal owns tenant isolation | In force |
| [0004](#0004-hosting-and-backup) | Hosting and backup | Replaced by 0016; WAL-G backup kept |
| [0005](#0005-external-monitoring) | External monitoring | In force |
| [0006](#0006-scf-read-api) | SCF read API | In force |
| [0007](#0007-sign-up-with-approval) | Sign-up with approval | In force in the code; no sign-up screen since #186 |
| [0008](#0008-custom-events-and-wallets-kit) | Custom events and Wallets Kit | In force |
| [0009](#0009-high-availability) | High availability | Rejected by 0016 |
| [0010](#0010-wallets-kit-opt-in-adapter) | Wallets Kit opt-in adapter | In force |
| [0011](#0011-umami-relay-limit) | Umami relay limit | In force, off by default |
| [0012](#0012-api-ingestion-through-caddy) | API ingestion through Caddy | In force |
| [0013](#0013-nginx-on-the-host) | Nginx on the host | Replaced by 0014 |
| [0014](#0014-infra-in-docker-compose) | Infrastructure in Docker Compose | In force |
| [0015](#0015-optional-rfp-features) | Optional RFP features | In force |
| [0016](#0016-production-on-a-vps) | Production on one VPS | In force |
| [0017](#0017-operator-invites) | Operator invites | In force in the code; disabled since #186 |

## 0001. Base tool

- Web analytics run on **Umami**, pinned to **v3.4.1**, used headless (ingestion, storage, statistics API) with no fork. Upgrades only by PR, with a release at least two weeks old ([`umami.md`](umami.md)).
- **Why:** MIT license (GoatCounter's EUPL is modified), PostgreSQL only (the RFP needs Postgres for API metrics), an active team of maintainers for the handover, and the RFP's minimum metrics out of the box.
- Umami has no open sign-up, no comparative view and no API metrics; those live in the portal. Session recording and heatmaps stay off, with a test.

## 0002. Architecture and stack

- **TypeScript** for the portal (Next.js) and the browser script; **Go** only for ingestion in `services/`: the web gateway and an OpenTelemetry Collector built with OCB plus its own components.
- One PostgreSQL cluster with two databases: `umami` (Umami's) and `stellytics` (tenants, keys, API metrics).
- API metrics: counters and fixed-bucket histograms per tenant, service, route and status, partitioned by month, rolled up from 1 minute to 1 hour and 1 day. **No TimescaleDB:** its compression and continuous aggregates are under a non-OSI license.
- Privacy by architecture: the gateway truncates the IP before Umami sees it; no cookies or browser storage.
- **Why:** the OTel Collector already solves OTLP; one language per side keeps the monorepo easy to hand over.

## 0003. Portal isolation

- The **portal alone** enforces isolation between tenants, for web data (read from Umami) and API data (read from Postgres).
- The tenant always comes from the session, never from a client value. All data access goes through `src/lib/data/` and `src/lib/umami/` with a context from `src/lib/access.ts`; a lint rule enforces it, and the isolation suite runs in CI.
- The portal creates only sites in Umami, owned by one service account. Umami is never reachable from outside.
- **Why:** tenants never talk to Umami, so Umami's own access control is never exercised; isolation needs one owner.

## 0004. Hosting and backup

Replaced by [0016](#0016-production-on-a-vps). What remains: **continuous WAL-G backup** of Postgres, encrypted on the client (libsodium, key kept off the server), with a daily base backup and point-in-time restore tested in CI. Optional since the public demo: with `WALG_S3_*` empty, `deploy.sh` runs the stack without backup and warns.

## 0005. External monitoring

- **Prometheus, blackbox exporter and Alertmanager** on a second, small host, separate from production, so the monitor does not go down with it.
- Probes every 15 seconds over HTTPS: portal (`/api/health`), web gateway (`/healthz`) and API ingestion.
- E-mail alerts: endpoint down for 1 minute, certificate expiring in under 14 days, probe failing, prober down. An optional always-firing `Watchdog` goes to an external heartbeat service, to catch the monitor itself going down.
- Rules and alerts are tested in CI (`monitoring` job).

## 0006. SCF read API

- `GET /api/v1/projects`, `/api/v1/web` and `/api/v1/api` in the portal, authenticated by an operator read key `nrk_<prefix>_<secret>`. Only the prefix and SHA-256 are stored.
- One scope: the global metrics of active projects, the same as the operator dashboards. A key works while its creator is an operator; at most 20 active keys.
- Limits in memory: 60 requests per minute per key, 120 key lookups per minute per truncated IP. Every rejection is the same `401`. No CORS: server to server only.
- **Why:** the SCF feeds spreadsheets and reports without access to Umami or the database, through the same isolated data layer.

## 0007. Sign-up with approval

- With `SIGNUP_APPROVAL=true`, a new project starts `pending`, sees only a waiting page and cannot ingest until an operator approves it. Rejecting means removing, with a reason. Every step goes to `audit_log`.
- Off by default. Since #186 the portal has no sign-up screen; the logic remains in the code.

## 0008. Custom events and Wallets Kit

- The script exposes `window.stellytics.event(name, properties?)`. The script validates, and the gateway validates again: name of 1 to 50 characters, up to 10 properties, limited sizes and types.
- Automatic Wallets Kit capture is **not possible**: the kit reports only through callbacks in the tenant's own module, which a separate script cannot reach without monkey patching.
- Hard privacy rule: no wallet address, public key, transaction hash or amount, ever.

## 0009. High availability

Rejected by [0016](#0016-production-on-a-vps). The 99.99% (ingestion) and 99.9% (dashboards) figures are reported as RFP targets, not as commitments ([`sla.md`](sla.md)).

## 0010. Wallets Kit opt-in adapter

- Script v1.3.0 added `window.stellytics.wallets(kit, KitEventType)`: one call from the tenant, not automatic capture.
- It subscribes only to `WALLET_SELECTED` (sends `wallet_selected` with the wallet's module ID, at most 32 characters) and `DISCONNECT` (sends `wallet_disconnected`). Never `STATE_UPDATED`, which carries the address.
- Idempotent per kit, never throws, no storage.

## 0011. Umami relay limit

- `RELAY_MAX_INFLIGHT` caps simultaneous relays from the gateway to Umami; `RELAY_QUEUE_WAIT` (default 250 ms) is how long a request waits for a slot. **Default `0`: off**, behaviour unchanged.
- When saturated, the gateway answers `204` and drops the event, like other drops, so the status reveals nothing. Dropped events are counted and logged once a minute, without IP, User-Agent or site.
- Only the relay is limited; a saturation drop does not spend the IP's fingerprint quota.
- Pending maintainer decision: do not enable it in production yet.

## 0012. API ingestion through Caddy

- The collector and the rollup job run in `infra/compose/prod.yaml` with no published port. OTLP reaches them through Caddy on its own host (`API_HOST`), port 443: HTTP on `/v1/*`, gRPC by content type; everything else is `404`.
- The collector has a memory ceiling (`COLLECTOR_MEM_LIMIT`, 512 MB by default).
- Open: no per-IP or per-key request limit at the proxy or the collector.

## 0013. Nginx on the host

Replaced by [0014](#0014-infra-in-docker-compose). Nginx with Certbot on the host was tried for one day and dropped in favour of Caddy in Compose.

## 0014. Infra in Docker Compose

- Every service, the public proxy included, runs in Docker Compose. **Caddy** is the only container with public ports (80 and 443), gets TLS certificates automatically and routes to the portal, gateway and collector.
- Postgres is published only on the server's loopback, for administration through an SSH tunnel. Umami is never published.
- Caddy writes no access log and filters request fields out of its error logs.

## 0015. Optional RFP features

- **Custom events:** adopted; the site dashboard shows the 10 most frequent.
- **Wallets:** adopted through the one-line opt-in adapter. "No tenant configuration" is not met, and the proposal must say so.
- Script **v1.5.0** ignores the wallet the kit remembers, so only real choices count. Older versions stay published, unchanged.
- The SCF view and the read API do not show events or wallets yet.

## 0016. Production on a VPS

- Production is **one VPS with Docker Compose**: `init.sh` prepares the host and `.env.production`, `deploy.sh` builds and starts `infra/compose/prod.yaml` and installs the backup timer.
- WAL-G backup to any S3-compatible bucket. The operator chooses and declares the provider and region (data residency). The bucket is optional (the demo runs without one); without it a server failure loses the data.
- OpenTofu, Ansible and all high-availability pieces are removed. External monitoring stays on its own host (`infra/monitoring/configure.sh`).
- **Why:** a setup another team can rebuild from the repository alone. A server failure means downtime until a restore from backup ([`deploy.md`](deploy.md)).

## 0017. Operator invites

- `operator.mjs invite` e-mails a single-use link, valid for 3 days; only the token's SHA-256 is stored, and the row is deleted once used. Only people with SSH and sudo on the server can run it. Every step goes to `audit_log`.
- Since #186 the portal has no `/invite` page, so the command is disabled; use `operator.mjs create`.

## Adding a decision

Add a numbered section at the end and a row to the table. When a decision changes, update its section and status instead of adding a parallel one, and say in the commit which decision changed and why.
