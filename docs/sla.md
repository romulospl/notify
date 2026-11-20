# Availability and vulnerability fix targets and commitments

Issue [#52](https://github.com/romulospl/stellytics/issues/52). Architecture decision in [ADR 0016](adr/0016-production-on-a-vps.md) (production on a single VPS, without high availability).

> **Required reading.** The production architecture **does not sustain the RFP targets** (99.99% for ingestion and 99.90% for dashboards): it is a single VPS, with a single Postgres and no replica ([ADR 0016](adr/0016-production-on-a-vps.md)). High availability was taken out of scope because the RFP does not demand it as an architecture requirement. This document separates what is an RFP **target** from what is a project **commitment**: the commitment is **99.5% per month for ingestion and for dashboards**, and vulnerability fixes within **24 hours (critical) and 7 calendar days (high)**. Today there is a proof of concept live (`stellytics.xyz`, `e.stellytics.xyz` and `otlp.stellytics.xyz`), hosted in Brazil and without pilots; production moves to an EU region in Tranche 1. No availability measurement has been published yet.

## 1. The RFP targets

Source: RFP `scf-web-api-analytics` ("Web and API Analytics for Stellar Ecosystem Projects"), Stellar Light, via the stellar-raven MCP (`scout.getRfps`), consulted on **15 November 2026** (quarter q4-2026, status `open`; URL `https://stellarlight.xyz/ideas/scf-web-api-analytics`). Text, section "Hosting and Handover": the proposer hosts and supports for 12 months after the last tranche, with "targets: 99.99% ingestion and 99.90% dashboard availability, critical and high vulnerabilities patched within 24 hours". I did not confirm whether the official SCF rules (outside Stellar Light) use the same values or whether they are contractual targets; treat the text above as the source.

| Item | RFP target | Error budget (30 days) |
|---|---|---|
| Ingestion (web and API) | 99.99% | 4.32 min |
| Dashboards | 99.90% | 43.2 min |
| Critical and high vulnerabilities | fixed within 24 h | n/a |
| Support tickets | response within 5 business days, resolution within 10 | n/a |

## 2. Target, commitment and what the architecture sustains

| Item | RFP target | Project commitment today | What today's architecture sustains | What it would take (out of scope, ADR 0016) |
|---|---|---|---|---|
| Web ingestion | 99.99% | **99.5% per calendar month**, measured and reported (section 3) | A single VPS and a single database: does not sustain 99.99%; 99.5% leaves 3 h 36 min per month for deploys and VPS outages | Replicated ingestion for 99.9%; 99.99% requires a database with failover (three nodes), deploys without interruption, measurement and rehearsals; none of this exists or is promised |
| API ingestion | 99.99% | **99.5% per calendar month**. Collector and `rollup` in `prod.yaml`, on the same VPS, behind Caddy (ADR 0012) | External test of the OTLP host (the monitoring `API_URL`) | Collector replica and end-to-end measurement |
| Dashboards (portal and read API) | 99.90% | **99.5% per calendar month**, measured and reported | One VPS: the 43 min/month budget of the RFP target is consumed by one bad deploy or one VPS outage; the 99.5% one (3 h 36 min) fits both | Database replica and failover, replicated portal |
| Critical and high vulnerabilities | 24 h | **Assessment within 48 h; fix within 24 hours (critical) and 7 calendar days (high)** from receipt or internal identification (`SECURITY.md`); see section 5 | The technical process (signed release, deploy by digest) can be fast; there is no continuous on-call | Continuous on-call and rehearsals to extend the 24 h to high ones |
| Support tickets | 5 and 10 business days | **The same 5 and 10 business days**, through public issues ([`support.md`](support.md)) | Two people responsible (Dione and Rômulo) | n/a |

**Decision:** commit to 99.5% availability per calendar month for ingestion (web and API) and for dashboards, and, with two maintainers and no continuous on-call, assessment of possibly critical or high reports within 48 hours and a fix within 24 hours (critical) and 7 calendar days (high), counted from receipt or internal identification. The RFP targets of 99.99% and 99.90% are not guaranteed: they would require the high availability that ADR 0016 took out of scope.

## 3. What is measured and how

### 3.1 Indicator (SLI)

Availability of an endpoint = fraction of the probes, in the window, that passed the configured module: 2xx for web and dashboard, 401 for the authenticated OTLP probe without credentials.

| Component | Probe (`infra/monitoring`) | Status |
|---|---|---|
| Portal / dashboards | `GET /api/health` on the portal host, blackbox `http_2xx` module, every 15 s | Exists |
| Web ingestion | `GET /healthz` on the ingestion host: 2xx only with Postgres and Umami responding | Exists |
| API ingestion | `POST` without a key to `API_URL` (optional in `infra/monitoring/configure.sh`), expects the collector's 401 | Exists if `API_URL` is set; does not prove that a metric is stored |

Honest limits of the current indicator:

- `/healthz` proves that the gateway responds and that Postgres and Umami respond to it (result cached for 5 s), **not** that an event is accepted end to end (JS proof, `ingest_site`, write to Umami). A synthetic probe of `POST /e` with a test site **does not exist**.
- The `component="stack"` probe (`/healthz/stack`, internal check on the VPS: containers, WAL, backup, disk) raises the `StackUnhealthy` alert and does **not** enter the availability calculation.
- The probe runs from **one** vantage point (one monitoring host, separate from the VPS). A network failure of the monitor would look like a production outage, and the other way round too.
- The resolution is 15 s; shorter outages can go unnoticed.

### 3.2 Calculation (proposed, not executed)

With the data from the monitor's Prometheus (**30-day** retention, `--storage.tsdb.retention.time=30d` in `infra/monitoring/compose.yaml`), per component:

```promql
avg_over_time(probe_success{job="endpoints", component="<component>"}[30d])
```

This expression and the `component` label (used in `alerts.yml`) **were not executed** against real data. Since retention is 30 days, a 31-day month loses its first day: generate the report on the last day of the month, or increase retention before committing to any number. The values kept in the monthly report are the long-term evidence.

### 3.3 Window and exclusions

- **Window:** calendar month in UTC.
- **Proposed exclusions** (they must be recorded in the report, with time and reason): maintenance announced at least 72 h in advance in the portal or in a public issue, limited to a total of 60 min per month; failure of the tenant's client or network; proven unavailability of the hosting provider (record from the provider's status page); outage caused by abuse (volume attack) while Caddy has no per-IP limit (ADR 0006). A failed deploy, migration or certificate renewal is **not** an exclusion.
- Outage of the monitoring host itself: the period without data is counted as unknown and declared in the report, not as available.

### 3.4 Monthly report

By the 5th business day of the following month, a public note in `docs/` or an issue, with: availability per component, minutes of unavailability, each incident (start, end, cause, fix), exclusions applied, and the month's critical and high vulnerabilities with the time to fix. There is **no** automation or template yet; the first report requires creating both.

## 4. What each target needs

Production is a single VPS, with Docker Compose ([ADR 0016](adr/0016-production-on-a-vps.md)). Ingestion replica, Postgres replica, failover and load balancer **do not exist** in the repository: they were removed for being outside what the RFP requires. For reference, what each target would take:

- **99.9% for ingestion:** two or more ingestion instances behind a load balancer or floating IP, rolling deploy, a pager in addition to email.
- **99.9% for dashboards:** a Postgres replica with rehearsed promotion, a replicated portal with only one instance running migrations.
- **99.99%:** the two items above plus a three-node database, failover measured in seconds, multiple monitoring vantage points, 12 months of measurement experience. **Not promised.**

The gateway can already serve the expired `ingest_site` when the database fails (`SITE_STALE_TTL`, off by default). This does **not** change the commitment, which stays at 99.5%.

## 5. Response to critical and high vulnerabilities

Existing process, to reuse: [`SECURITY.md`](../SECURITY.md) (private report through GitHub's Security tab), [`docs/runbooks/vulnerabilities.md`](runbooks/vulnerabilities.md) (containment, fix, release, verification), a release signed with cosign and an SBOM attestation (`.github/workflows/release.yml`), and the deploy through `deploy.sh` (`docs/deploy.md`), which by default builds the images from the checkout; release images can be used by digest, but nothing checks the signature automatically.

Script for a critical one, counted from receipt or internal identification, not from classification. For a high one, the same steps apply with the end on the 7th calendar day.

| Time | Step |
|---|---|
| immediately | Confirm receipt, reproduce and classify (CVSS 3.1). Apply the runbook's **containment** (revoke key, block project, demote operator, stop the service) |
| within 24 h | Fix in a private branch or private advisory, with a test that fails before the fix; green CI; release (`vX.Y.Z`) and signed images; deploy (`deploy.sh`), the verification of step 3 ("Check production") of `docs/deploy.md` and a new check |
| afterwards | Disclosure (advisory) |

**External dependency.** If there is no upstream fix, contain the impact and communicate the risk of missing the deadline; containment does not count as a fix. Critical or high fixes may skip the 14-day wait in a specific and documented way, as described in the [runbook](runbooks/vulnerabilities.md). Renovate can offer security updates before the wait ends when GitHub alerts are enabled, but it is not installed; pnpm has its own rule and requires a specific exception.
**Known gaps:**
- Two maintainers, with no defined on-call; the deadlines include nights, weekends and holidays. The 24 hours for critical ones have not been rehearsed yet.
- The signed release has never actually run (there is no published release), and the deploy does not check the signature; the runbook says the same.
- A deploy on a single VPS interrupts the service; there is no rolling deploy.
- Withdrawing a vulnerable version of the tracking script is not trivial (see the runbook).

## 6. Pending items and open decisions

- On-call, end-to-end probe, monthly report. High availability is out of scope (ADR 0016); going back to it would require a new decision.

## 7. What this document does not do yet

No availability measurement has been published: the proof of concept is live, but the first monthly report does not exist yet, and the vulnerability script has not been exercised on a real case. There is no synthetic end-to-end probe, automated monthly report or pager. The private vulnerability channel was enabled on 19 November 2026.
