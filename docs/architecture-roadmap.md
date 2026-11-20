# Architectural risk roadmap

This roadmap organizes the risks identified in the review of the architecture against the RFP. It complements the existing backlog; it does not replace the issues already open. The status must be checked on GitHub before creating issues, because querying the API was not available on 16 November 2026.

## Suggested order

### P0 — Before operating with real tenants

| Topic | Existing issue | Next step | Completion criterion |
|---|---|---|---|
| Privacy, retention and erasure | #40 documents the situation; the progress record says there are no implementation issues | Open issue(s) for Umami event retention, erasure of project and account data, and handling of data subject requests | Policy and deadlines documented; erasure executable and auditable; removed data also stops reappearing after a backup restore, within a defined deadline |
| Origin and replay of web events | #41 documents that `Origin` is not validated and the proof can be reused while it is valid | Open a decision and mitigation issue; measure the impact of validating the origin and of making the proof single-use or limiting replay | The decision explains the residual risk; tests show that events from unauthorized origins and replays outside the chosen policy are refused |
| Tenant isolation | #21 implements the suite; ADR 0003 assigns isolation to the portal | Keep as a continuous control: every new read/write endpoint must include isolation tests | CI covers new routes and queries; operators and tenants have separately tested scopes |
| Privacy of API dimensions | #32 normalizes known patterns; a custom `http.route` may contain personal data | Open an issue for a validation/minimization policy for `http.route` and for cases not covered by the normalization | Example routes with an email, name, token or secret do not persist sensitive values; limits and behavior are documented |

### P1 — Before using metrics in SCF decisions

| Topic | Existing issue | Next step | Completion criterion |
|---|---|---|---|
| Integrity and interpretation of API metrics | No specific issue identified | Open an issue to document the trust model: the key proves attribution, not truthfulness; define anomaly signals without claiming to validate the real activity | Dashboards and API explain the provenance and limitations; observable limits and anomalies are defined and tested |
| Comparable metric definitions | #28/#29 and #37/#38 implement dashboards | Open a glossary/methodology issue for unique visitor, session, bounce, time window, timezone, p50/p95 and missing data | Each metric has its definition, window, limitations and handling of unavailability documented in the UI and in the operator docs |
| Auditing of global access | #48 covers keys and the read API; ADR 0006 records the absence of per-read auditing | Open an issue to decide on and implement proportionate auditing of queries made with a global key | Operators can investigate misuse without recording a secret, sensitive payload or unnecessary cardinality; audit log retention defined |
| Abuse and quota of API ingestion | The progress record lists the per-key limit and the collector replica as pending; check related issues before opening a duplicate | Complete the per-key limits and the alerts on abnormal usage, respecting legitimate tenants | One tenant cannot consume unlimited resources; alerts and responses to excess are documented and tested |

### P2 — Operational robustness and evolution

| Topic | Existing issue | Next step | Completion criterion |
|---|---|---|---|
| Dependency failures and event loss | #52 deals with high availability; ADR 0009 records the absence of a queue/buffer and possible loss | Use #52 to decide the behavior per dependency; open a separate issue only if the decision requires a durable queue | For each failure, there is an explicit behavior (refusal, loss or buffer), signaling, recovery and an exercise test |
| Fair sharing of web capacity | #134 deals with the per-site limit on relays to Umami | Conclude the decision and measure contention between tenants; avoid a fixed quota that wastes capacity | A single site does not monopolize ingestion when there is contention; multi-tenant tests show the policy and its metrics |
| Resilience of privileged access | #52 and the runbooks cover availability/operation, but do not replace the access design | Confirm that the operational documentation defines the granting, revocation and periodic review of access to the VM/database | Privileged access has owners, a revocation procedure and a verifiable audit trail |

## Proposed new issues

The following issues were not found in the local mapping and should be created on GitHub after checking for duplicates:

1. **Privacy: retention and erasure of web data, accounts and tenants** — separate the legal/policy scope from the implementation work, including backups and the audit log.
2. **Web gateway: validate origin and limit replay of the JavaScript proof** — start with a threat/compatibility decision and implement the approved mitigation.
3. **API: protect route dimensions against personal data and secrets** — review `http.route` and the default normalization.
4. **Trust in API metrics: document provenance and detect anomalies** — make clear the boundary between attribution by key and truthfulness of the instrumentation.
5. **Metrics: publish definitions and comparison rules** — glossary for dashboards, API and operators.
6. **SCF read API: audit queries made with a global credential** — assess the granularity, retention and minimization of the logs.

Do not open new issues for isolation (#21), high availability/failures (#52), per-site limit (#134), load test (#51), or read key (#48): there is already associated work. Confirm the current state of these issues before planning execution.

## Dependencies and sequence

```text
Privacy/erasure ─────┬─> pilots with real data ─> operation
Origin/replay ───────┤
Routes without PII ──┘

Metric definitions ─> trust/use by the SCF ─> comparison between projects
Auditing of the global API ──────────────────────> downstream consumers

HA/failures (#52) + per-site limit (#134) + API limits ─> SLA and scale
```

The RFP asks for real adoption, service for 12 months and metrics usable by the SCF. For that reason, P0 must come before the broad instrumentation of pilots; P1 must be complete or explicitly declared as a limitation before the dashboards are used for funding decisions. P2 can be delivered in stages, as long as the behavior and the residual risk are declared.
