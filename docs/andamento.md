# Project progress

Record of what has been done, the decisions taken and the next steps. Updated on **2026-11-19**.

## Summary

| Item | Status |
|---|---|
| MVP scope | Defined from the RFP (section [MVP](#1-mvp-defined-from-the-rfp)) |
| Backlog | 10 epics and 77 issues on GitHub; 16 open: epics E1, E7, E8, E9 and E10, plus #42–#47, #64, #65, #140 and #174 |
| Base tool | **Umami v3.4.1** ([ADR 0001](adr/0001-ferramenta-base.md)) |
| Architecture and stack | Defined ([ADR 0002](adr/0002-arquitetura-e-stack.md)) |
| Production | One VPS with Docker Compose and Caddy, installed by `init.sh` and `deploy.sh`, continuous WAL-G backup, no high availability ([ADR 0016](adr/0016-producao-em-vps.md)). Portal, web gateway, Umami, OTel collector and rollup all run in `infra/compose/prod.yaml`. External monitoring by `infra/monitoring/configure.sh` (#15). Data residency region: **not decided yet** |
| Code | Epics E2–E6 closed: portal, tracking script and web gateway, API pipeline, and the tenant and SCF web and API dashboards. Details in [`e2-implementacao.md`](e2-implementacao.md), [`e4-implementacao.md`](e4-implementacao.md) and [`e6-implementacao.md`](e6-implementacao.md) |
| Validation | Deploy guide rehearsed on a clean Ubuntu 24.04 container (PR #176, comment on #42); the acceptance criterion is still an outside operator following [`validation/deploy.md`](validation/deploy.md) |
| What remains for the MVP | Pilots (#44 → #45/#46 → #47), outside validation of the guides (#42, #43) and an account action (#140). See [section 6](#6-next-steps) |

## 1. MVP defined from the RFP

Source: the SCF RFP *Web and API Analytics for Stellar Ecosystem Projects* (id `scf-web-api-analytics`, consulted on 2026-11-13).

The MVP is the smallest version that **real pilot projects** (3 with web analytics and 1 with API analytics) can use and that the SCF can query. What belongs to 12 months of operation, scale or handover was left out.

### In the MVP

1. **Base and multi-tenant:**
   - Umami on PostgreSQL;
   - self-service sign-up;
   - strict isolation with tests;
   - SCF operator with a global view;
   - project removal by the operator.
2. **Web collection:**
   - script with a pinned version and SRI;
   - names that ad blockers do not block;
   - anti-bot: proof of JS execution and a limit of fingerprints per IP;
   - privacy: truncated IP, no cookies and no personal data;
   - installation examples for static HTML, SPA and SSR.
3. **Web dashboards:**
   - tenant dashboard with the 7 minimum metrics (page views, unique visitors, referrers, session duration, bounce, country, device and browser);
   - SCF global comparative dashboard.
4. **API pipeline:**
   - OTLP collector with an ingest key, dropping traces, spans and logs;
   - route normalization with tests;
   - counters and histograms in Postgres;
   - rollup with 24-month retention;
   - dual-export guide.
5. **API dashboards:**
   - tenant dashboard with volume, status code and p50/p95 per endpoint;
   - SCF global dashboard.
6. **Monorepo and minimal operation:** OSI license, IaC, CI with tests, minimal documentation and basic monitoring.
7. **Proof of use:** 3 web pilots, 1 API pilot and a video of the tenant experience.

### After the MVP (epic E9)

All of these were done after the MVP code, except the handover itself:

- SLA targets and the vulnerability and support commitments (#52, [`sla.md`](sla.md)); high availability was dropped by [ADR 0016](adr/0016-producao-em-vps.md)
- Load test for 1 million requests per day (#51)
- SCF read keys for other systems to consume the metrics (#48)
- Sign-up with prior approval (#49)
- Custom events and Stellar Wallets Kit capture (#50)
- Runbooks (#53) and the handover plan (#54); the handover execution is #174

## 2. Backlog on GitHub

Repository: [romulospl/stellytics](https://github.com/romulospl/stellytics/issues). Board: [GitHub Project 1](https://github.com/users/romulospl/projects/1/views/1).

- **Epics:** E1–E9 are issues #1–#9; E10 is #63.
- **Issues:**
  - numbered `[X.Y]`, each linked to its epic as a **sub-issue**;
  - each has "What to do", acceptance criteria as a checklist and "Depends on", with links;
  - the `[X.Y]` number identifies the issue within the epic but **is not the execution order**: "Depends on" is.
- **Labels:** `epic`; one per epic; `mvp` on the issues of E1–E8; `pos-mvp` on E9; E10 issues carry only their epic label; `URGENTE` marks priority.

| Epic | Issues | Scope | State |
|---|---|---|---|
| [#1 E1](https://github.com/romulospl/stellytics/issues/1) | #10–#15, #55, #56, #132, #140 | Monorepo foundation and infrastructure | Open: #140 |
| [#2 E2](https://github.com/romulospl/stellytics/issues/2) | #16–#21, #57–#60 | Multi-tenant, sign-up and access control | Closed |
| [#3 E3](https://github.com/romulospl/stellytics/issues/3) | #22–#27, #61, #62 | Web analytics collection | Closed |
| [#4 E4](https://github.com/romulospl/stellytics/issues/4) | #28, #29 | Web analytics dashboards | Closed |
| [#5 E5](https://github.com/romulospl/stellytics/issues/5) | #30–#36 | API analytics pipeline (OpenTelemetry) | Closed |
| [#6 E6](https://github.com/romulospl/stellytics/issues/6) | #37, #38 | API analytics dashboards | Closed |
| [#7 E7](https://github.com/romulospl/stellytics/issues/7) | #39–#43, #138, #139, #154 | Documentation, privacy and compliance | Open: #42, #43 |
| [#8 E8](https://github.com/romulospl/stellytics/issues/8) | #44–#47 | Pilots and proof of adoption | Open: all |
| [#9 E9](https://github.com/romulospl/stellytics/issues/9) | #48–#54, #133–#137, #174 | Post-MVP | Open: #174 |
| [#63 E10](https://github.com/romulospl/stellytics/issues/63) | #64, #65 | Proposal and SCF submission | Open: all |

#153 (follow-ups from the review of PR #151) has no epic and is closed.

## 3. Decisions

The ADRs are indexed in [`adr/README.md`](adr/README.md). The ones that shape the current system:

- **Umami as the base tool ([ADR 0001](adr/0001-ferramenta-base.md)):** MIT license, active maintainers, PostgreSQL only. Pinned to **v3.4.1**. Umami has no open sign-up, so sign-up, the comparative dashboard and the API metrics live in the portal; session recording and heatmaps are off.
- **Architecture and stack ([ADR 0002](adr/0002-arquitetura-e-stack.md)):** TypeScript for the Next.js portal and the tracking script; Go only for ingestion (web gateway and an OCB-built OTel collector); PostgreSQL with `umami` and `stellytics` databases, native monthly partitioning and 1 min → 1 h → 1 day rollups, no TimescaleDB (TSL license). The infrastructure part was superseded by ADR 0016.
- **Isolation in the portal ([ADR 0003](adr/0003-isolamento-no-portal.md)) and the [E2 spec](specs/e2-tenants-e-controle-de-acesso.md):** the portal reads Umami with a service account that sees everything, so isolation is the portal's job. Decisions D1–D6: one tenant per user; the SCF operator is not a tenant member; no admin role (operators are created by script); one database user per service; the API service comes from the ingest key; the operator can reactivate a removed tenant.
- **Production on one VPS ([ADR 0016](adr/0016-producao-em-vps.md)):** one path, a Debian/Ubuntu VPS with Docker Compose, Caddy and encrypted WAL-G backup to S3-compatible storage. Provider and region are the operator's choice. It removed the managed path (Hetzner, OpenTofu, Ansible, [ADR 0004](adr/0004-hospedagem-e-backup.md)) and all high availability from #52 ([ADR 0009](adr/0009-alta-disponibilidade.md)): replication, standby, ingestion replicas and the failover runbook. The RFP does not require high availability; it requires infrastructure recreatable from the monorepo.
- **Optional RFP features ([ADR 0015](adr/0015-optional-rfp-features.md)):** custom events and the opt-in Stellar Wallets Kit adapter ([ADR 0008](adr/0008-eventos-customizados-e-wallets-kit.md), [ADR 0010](adr/0010-adaptador-opt-in-do-wallets-kit.md)).
- **Other ADRs:** external monitoring ([0005](adr/0005-monitoramento-externo.md)), SCF read API ([0006](adr/0006-api-de-leitura-do-scf.md)), sign-up with approval ([0007](adr/0007-cadastro-com-aprovacao.md)), relay limit to Umami ([0011](adr/0011-limite-de-repasses-ao-umami.md), **not enabled in production pending a maintainer decision**), API ingestion through Caddy ([0012](adr/0012-ingestao-de-api-pelo-caddy.md)).

## 4. Record by epic

Dates are when the work landed. Entries describe the state on `main` today; for the full history use `git log` and the PRs.

### E1: foundation and infrastructure

- **#11, #12, #13 (2026-11-13):** monorepo with MIT `LICENSE`, pnpm workspaces, Turborepo and `services/go.mod`; local Compose with Postgres 17 and Umami 3.4.1 pinned by digest; CI on GitHub Actions (actions pinned by SHA, Postgres in tests, Compose tested on every PR). `main` has **no branch protection** by decision of 2026-11-13.
- **#55, #56:** Renovate with a 14-day wait, release workflow with SBOM and cosign-signed GHCR images; `SECURITY.md`, `CONTRIBUTING.md` and issue templates.
- **#14 (2026-11-14 to 2026-11-19):** production on a VPS ([ADR 0016](adr/0016-producao-em-vps.md), PR #169), step by step in [`deploy.md`](deploy.md). `deploy.sh` builds images from the checkout and checks the variables of `.env.production.example`; the daily base backup runs from `stellytics-backup.timer` at 03:00 UTC. Restore (including point in time) is tested on every PR by `infra/compose/test/prod-stack-test.sh`, which also checks that only Caddy publishes ports, that Umami has no route and that Postgres listens only on loopback.
- **#15 (2026-11-14):** Prometheus, blackbox and Alertmanager on a host separate from production ([ADR 0005](adr/0005-monitoramento-externo.md)), tested in the CI `monitoring` job. PR #172 made it cover the ingestion dependencies, backups and the rollup.
- **#132:** Go Dockerfiles moved to `golang:1.26.11` for reachable stdlib vulnerabilities found by the dependency scan.
- **Open: #140**, an account action: enable GitHub private vulnerability reporting and install the Renovate app (without it `renovate.json` has no effect).

### E2: multi-tenant and access control (closed)

Portal skeleton with sign-in (#57), tenant model (#16), Umami service account (#58), single data access layer (#18), ingest keys (#59), email verification (#60), self-service sign-up (#17), SCF operator (#19), project removal and reactivation (#20) and the isolation suite (#21), which also covers the collector end to end (`services/collector/e2e/isolation_test.go`). Details in [`e2-implementacao.md`](e2-implementacao.md).

### E3: web collection (closed)

Tracking script with a pinned version and SRI (#22) and the Go web gateway (#61), plus ad-blocker-safe names, IP truncation, JS proof, fingerprint limit, integration examples and closing direct access to Umami (#23–#27, #62). PR #173 shows the ready-to-copy script tag on each site's page.

### E4: web dashboards (closed)

Tenant dashboard with the 7 metrics at `/sites/[siteId]` (#28) and the SCF web overview at `/operator/web` with filter, sort and comparison of 2 to 4 projects (#29). Details in [`e4-implementacao.md`](e4-implementacao.md).

### E5: API pipeline (closed)

Collector with key authentication, dropping traces, spans and logs, route normalization, Postgres schema (#30–#33); rollup 1m → 1h → 1d with 35 days at 1 min and 25 months in the rollups, run every 15 minutes by `services/rollup` (#34); example backend and dual-export guide in `examples/api-backend` (#35); end-to-end test in the CI `compose` job (#36). Spec: [`specs/e5-pipeline-de-api.md`](specs/e5-pipeline-de-api.md). The collector and the rollup run in production since PR #143; OTLP (HTTP and gRPC) enters through Caddy on a separate API host ([ADR 0012](adr/0012-ingestao-de-api-pelo-caddy.md)).

### E6: API dashboards (closed)

Tenant API dashboard at `/services/[serviceId]` (#37) and SCF API overview at `/operator/api` (#38), with the same numbers. Details in [`e6-implementacao.md`](e6-implementacao.md).

### E7: documentation, privacy and compliance

- **#39:** [`arquitetura.md`](arquitetura.md), with Mermaid diagrams of the web and API flows.
- **#40:** [`privacidade.md`](privacidade.md): what is collected, IP truncation, retention and data subject requests.
- **#41:** [`anti-bot-e-cadeia-de-suprimentos.md`](anti-bot-e-cadeia-de-suprimentos.md). Its gaps became the dependency scan ([`dependencies.yml`](../.github/workflows/dependencies.yml): `govulncheck`, `pnpm audit` and an OSI license allowlist in `scripts/licenses/allowed.json`) and #136 (reproducible builds).
- **#138:** vulnerability and support commitments set in `SECURITY.md` and [`suporte.md`](suporte.md) (PR #161).
- **#139:** license exceptions: `caniuse-lite` (CC-BY-4.0) accepted as a build-only exception, attributed in [`avisos-de-terceiros.md`](avisos-de-terceiros.md); `@img/sharp-libvips-*` (LGPL-3.0) not distributed, because the portal's image optimizer is off and the image ships no native `*.node` module.
- **#154:** right to erasure: account deletion in `/settings`, erasure of a removed project by the operator, Umami event retention in `services/rollup` (`UMAMI_RETENTION_DAYS`, default 183) and `audit_log` anonymization (`actor_user_id` becomes `[apagado]`). Individual data subject requests (rectification, portability, one visitor) follow the manual procedure in [`privacidade.md`](privacidade.md).
- **Open: #42** ([`deploy.md`](deploy.md)) until an operator who did not write it follows it on a real account; PR #176 recorded a team rehearsal on a clean Ubuntu 24.04 container. **Open: #43** ([`onboarding-de-tenant.md`](onboarding-de-tenant.md)) until a real pilot uses it (#45, #46). Validation scripts for both: [`validation/`](validation/deploy.md) (PR #171).

### E8: pilots (open)

Nothing done yet: #44 → #45/#46 → #47. See [section 6](#6-next-steps).

### E9: post-MVP

- **#48:** SCF read keys and the `/api/v1` read API ([ADR 0006](adr/0006-api-de-leitura-do-scf.md)).
- **#49:** optional sign-up with prior approval, `SIGNUP_APPROVAL` ([ADR 0007](adr/0007-cadastro-com-aprovacao.md)).
- **#50:** custom events (`window.stellytics.event`) and the opt-in Wallets Kit adapter, shown on the site dashboard (PR #168, [ADR 0015](adr/0015-optional-rfp-features.md)).
- **#51:** load test in `services/loadtest/`, report in [`relatorios/carga-1m-dia.md`](relatorios/carga-1m-dia.md). Measured on a local machine, so it does not prove production. Umami saturates near 200 page views per second.
- **#52:** SLA targets and error budget in [`sla.md`](sla.md). The high-availability primitives built for it were removed by ADR 0016.
- **#53:** runbooks in [`runbooks/`](runbooks/README.md); none exercised on a real production yet.
- **#54:** handover plan in [`transferencia.md`](transferencia.md) and tested data migration scripts (`infra/scripts/db-export.sh`, `db-import.sh`, `db-fingerprint.sh`).
- **#133, #134, #137:** gateway behavior under Umami saturation, per-site relay limit, and the gateway variables passed in production. **#135, #136:** replication alerts (later removed with HA by ADR 0016) and reproducible builds.
- **Open: #174**, executing the handover to the community operator between month 6 and month 12 of the service window (RFP §3.4).

### E10: proposal (open)

Drafts of the proposal and interest form in [`proposta/`](proposta/proposal.md) (PR #112). #64 and #65 stay open because submission is done by people: referral code, budget, team, pilots and letters, legal payee.

## 5. Repository files

| File | Content |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | Context for Claude Code; component guides in [`dev/`](dev/planning.md) |
| [`README.md`](../README.md) | Project overview, metrics, architecture, privacy and contribution |
| [`adr/`](adr/README.md) | Index, template and ADRs 0001–0016 |
| [`specs/`](specs/e2-tenants-e-controle-de-acesso.md) | E2 and E5 specs |
| [`deploy.md`](deploy.md), [`validation/`](validation/deploy.md) | Deploy guide and outside-validation scripts |
| [`onboarding-de-tenant.md`](onboarding-de-tenant.md) | Tenant onboarding for web and API |
| [`runbooks/`](runbooks/README.md), [`transferencia.md`](transferencia.md) | Operation and handover |
| `docs/andamento.md` | This record |

## 6. Next steps

MVP, in dependency order:

1. **[#44](https://github.com/romulospl/stellytics/issues/44):** recruit and confirm SCF-funded projects as pilots and get letters of interest. Depends on no code.
2. **[#45](https://github.com/romulospl/stellytics/issues/45) and [#46](https://github.com/romulospl/stellytics/issues/46):** onboard 3 web pilots and 1 API pilot. They also validate the onboarding guide, [#43](https://github.com/romulospl/stellytics/issues/43).
3. **[#47](https://github.com/romulospl/stellytics/issues/47):** demonstrate the global view live and record the tenant experience.
4. **[#42](https://github.com/romulospl/stellytics/issues/42):** an operator who did not write [`deploy.md`](deploy.md) follows it on a real account, using [`validation/deploy.md`](validation/deploy.md).
5. **[#140](https://github.com/romulospl/stellytics/issues/140):** account action: enable private vulnerability reporting and install the Renovate app.

Proposal: [#63](https://github.com/romulospl/stellytics/issues/63) with [#64](https://github.com/romulospl/stellytics/issues/64) (eligibility, referral code and interest form) and [#65](https://github.com/romulospl/stellytics/issues/65) (write the proposal).

After the MVP: [#174](https://github.com/romulospl/stellytics/issues/174), the handover execution (RFP §3.4).

Pending decisions:

- **Data residency region:** the region of the VPS and the backup bucket is the operator's choice and is **not decided yet** ([`privacidade.md`](privacidade.md)).
- **`RELAY_MAX_INFLIGHT`:** stays off in production until the maintainer decides ([ADR 0011](adr/0011-limite-de-repasses-ao-umami.md)).
