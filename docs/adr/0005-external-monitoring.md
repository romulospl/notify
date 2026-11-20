# 0005. External monitoring with Prometheus, on a separate VM

- **Status:** Accepted
- **Date:** 14/11/2026
- **Issue:** [#15](https://github.com/romulospl/stellytics/issues/15)
- **Depends on:** [ADR 0002](0002-architecture-and-stack.md), [ADR 0004](0004-hosting-and-backup.md)

## Context

#15 asks for the ingestion endpoints (web and API) and the dashboards to be monitored **from outside**, with an alert when they go down, and with the configuration versioned in the monorepo. ADR 0002 planned Prometheus, Grafana and Alertmanager in `infra/monitoring`.

Production is a single VM (ADR 0004). A monitor inside it goes down along with it, precisely in the most serious case.

## Decision

1. **A second, small VM in another Hetzner data center** (`fsn1`, Falkenstein; production is in `nbg1`). An OpenTofu rule prevents putting both in the same location. Firewall with SSH only from the administration networks.
2. **Prometheus + blackbox exporter + Alertmanager**, in Docker Compose (`infra/monitoring/`), with the same `base` and `docker` roles as production's Ansible (`infra/ansible/monitoring.yml`).
3. **What is probed**, over HTTPS, as a client sees it:
   - the portal (`/api/auth/ok`);
   - the web gateway (`/healthz`);
   - API ingestion, once the collector (#30) is published in production (variable `monitor_api_url`).

   The probes run every 15 seconds.
4. **Alerts by email:**
   - `EndpointDown`: no 2xx response for 1 minute;
   - `TLSCertificateExpiringSoon`: certificate expiring in less than 14 days, a sign that automatic renewal failed;
   - `ProbeFailing`: Prometheus cannot even ask blackbox for the probe (without this, the target would have no `probe_success` and no alert would fire);
   - `ProberDown`: blackbox itself is down;
   - a resolved email when the problem goes away.
5. **Optional heartbeat:** an always-firing alert (`Watchdog`) goes every 5 minutes to an external heartbeat service, if configured. If it stops arriving, the one that went down is the monitor.
6. **No Grafana for now.** To alert, Prometheus is enough; its interface and Alertmanager's are reachable through the SSH tunnel. The Grafana dashboards come in when there are internal metrics to show.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Monitor on the production VM itself | No extra cost | Goes down along with the VM; it is not external monitoring |
| Hosted uptime service (SaaS) | Nothing to operate | External dependency, not always open source; the configuration lives outside the repository |
| Uptime Kuma on a separate VM | Ready-made interface, many alert channels | The configuration lives in its database, not in versioned files (a #15 criterion) |
| Prometheus with Grafana right away | Ready-made dashboards | One more service and one more password, with no internal metrics to show yet |

## Consequences

- **Cost:** one more VM, the smallest that Hetzner offers.
- **The monitor also needs a watcher:** without the external heartbeat, the monitoring VM going down goes unnoticed. That is why the guide recommends configuring it.
- **What is not monitored yet:**
  - API ingestion, until the collector is published;
  - internal production metrics (disk, memory, database response time);
  - the age of the last backup.

  The last two come in together with Grafana.
- **The configuration is tested in CI** (`monitoring` job):
  - unit tests of the rules (`promtool test rules`);
  - the heartbeat interval in the generated configuration;
  - end to end, the test takes a target down and checks the alert email, the resolved one and the heartbeat, with the same configuration template that Ansible uses.
