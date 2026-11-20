# E6: what was implemented

Record of the implementation of epic [E6 (#6)](https://github.com/romulospl/stellytics/issues/6), API analytics dashboards, started on **14 November 2026**. E6 has no spec of its own: it runs inside the portal and reads the tables that the [E5 spec](specs/e5-api-pipeline.md) fixed (sections 4 and 5), with the isolation of [ADR 0003](decisions.md#0003-portal-isolation) and of section 4 of the [E2 spec](specs/e2-tenants-and-access-control.md).

## 1. Status

| Issue | What it is | PR | Commit |
|---|---|---|---|
| [#37 (6.1)](https://github.com/romulospl/stellytics/issues/37) | Tenant API dashboard | [#103](https://github.com/romulospl/stellytics/pull/103) | `55857e0`, `5497c27` |
| [#38 (6.2)](https://github.com/romulospl/stellytics/issues/38) | SCF global API dashboard | — | In review |

## 2. #37: tenant API dashboard

**Where:** `/services/[serviceId]` (`apps/portal/src/app/(private)/services/[serviceId]/`), "Overview" tab. The ingest keys, which used to be at that address, moved to the "Ingest keys" tab, at `/services/[serviceId]/keys`. The services appear under "API analytics", in `/dashboard`, and in the `/services` list.

**What it shows, for the chosen period:**

| Part | Content |
|---|---|
| Indicators | Requests, fraction of server errors (5xx), p50 and p95 latency |
| Requests chart | Columns per hour, day or month; the tooltip also brings 4xx and 5xx |
| Latency chart | p50 and p95 lines per bucket, with a legend and a label at the end of each line; a bucket without requests is a gap, not zero |
| Table per endpoint | Method and normalized route, requests, 4xx, 5xx, p50 and p95; the 100 routes with the most requests |
| Status | Each code with the name, the number and the fraction of the total |

Both charts have the equivalent table under "Show charts as a table".

**Reading the metrics:** `getServiceDashboard` in `src/lib/data/api-metrics.ts`. It receives the `TenantContext` and the service ID, checks that the service belongs to the tenant (`getApiService`) and only then reads the metrics, filtering by `tenant_id` **and** `api_service_id`. A service of another tenant or an archived one returns null without any metric read.

**Which table each stretch comes from** (`metricSources`):

- the job from #34 rolls up, every 15 minutes, the hours that ended at least 5 minutes ago, and the days from the hours;
- the cut between `api_metric_1h` and `api_metric_1m` is the smaller of the current hour minus one (slack for late batches from the collector) and the end of the tenant's last rolled-up hour (`max(bucket_start)` of 1h, through the `(tenant_id, bucket_start)` index);
- the dashboard reads `api_metric_1d` for the full days before that cut, `api_metric_1h` for the hours before it and `api_metric_1m` for the rest: with the job up to date, the last two hours; with the job stopped or late, everything it has not rolled up yet, instead of disappearing from the dashboard;
- a period by hour (24 hours) never uses `api_metric_1d`;
- the stretches do not overlap, so nothing counts twice.

A single query, with `GROUPING SETS`, returns the series, the endpoints, the statuses and the total. The percentiles use `api_metric_quantile(api_metric_sum_buckets(...))`, as the E5 spec requires: sum the histograms and compute over the sum.

**Choices:**

- **No change against the previous period**, unlike the web dashboard. The previous period does not start at the beginning of a bucket (it ends at "now minus the period"), and the rolled-up tables do not give the partial stretch. #37 does not ask for comparison; if needed, it comes in by reading the previous period from `api_metric_1h`.
- **An error is 5xx.** The main indicator is the fraction of server errors; the 4xx appear in the table, in the tooltip and in the status list, because they are often normal use (a 404 for a non-existent account, for example).
- **Latency in ms or s**, with one decimal place below 10 ms. The percentile stops at 10 s, the last bound of the histogram (D2 of the E5 spec), and appears as "≥ 10 s".
- **Same periods as the web dashboard** (`src/lib/period.ts`, in UTC) and the same selector.
- **An endpoint is method plus route.** The limit of 100 rows is generous: the collector limits to 500 routes per service and day (D4 of the E5 spec).
- **Keyboard:** each chart is a single Tab stop (the most recent bucket); the arrows, Home and End move between the buckets and open the tooltip. Without this, 90 days would be 90 stops per chart. It also applies to the web dashboard.
- **Fractions** never round to 0% or 100% when they are not exact ("< 0.1%", "> 99%").
- **Shared column chart:** the web dashboard's chart became the component `src/components/column-chart.tsx`, used by both dashboards. The latency one is in `services/[serviceId]/latency-chart.tsx`. Colours from positions 1 and 2 of the `dataviz` skill palette (blue and orange), in both modes.
- **Removed project** sees only the notice, without reading metrics (E2 spec, section 6).

**Tests:**

- `test/api-dashboard.test.ts`:
  - which table each stretch comes from, including right after midnight, with the job late and with nothing rolled up;
  - with the job stopped, the hours that only exist in 1m appear, without counting twice the ones already in 1h;
  - the read joins 1d, 1h and 1m without counting anything twice, with trap rows (minutes and hours that the rollup already covers, the partial current day, another service, another tenant);
  - percentile with checked interpolation;
  - rendered page, with the indicators, one column and one point per bucket, the endpoints and the statuses;
  - empty service, service of another tenant (404 on the dashboard and on the keys) and removed project.
- `test/isolation.test.ts`: two dashboard cases (#21). A sees only its own service, even with an impossible row (service of A with B's tenant), and the operator gets 404 (D2).
- **Checked that the tests catch failures:** removing the tenant filter from a stretch, letting the hours stretch overlap the minutes one, letting the period by hour read 1d and ignoring the last rolled-up hour make tests fail.

**Independent review** by a subagent: no isolation or SQL failure. Addressed: the fixed cut (data disappeared with the job late), the Tab stops, the rounding of fractions and a passage of `e2-implementation.md` that still pointed the keys to `/services/[serviceId]`.

**Checked in the browser** with about 6 thousand test rows (30 days): light and dark, desktop and 390px wide, periods of 24 hours, 7 and 30 days, tooltip of the latency chart.

## 3. #38: SCF global API dashboard

**Where:** `/operator/api` (`apps/portal/src/app/(private)/operator/api/`), with links in the operator header ("API analytics") and in `/operator`. Whoever is not an operator gets 404.

**What it shows:** one row per **active** project, with the number of services, the requests (with a proportional bar), the fraction of 5xx and of 4xx and the p50 and p95 latency of all the project's requests. A filter by name or slug, sorting by clicking the header and the same period selector. Everything through GET, like the SCF web dashboard (#29). A summary above the table says how many projects sent data in the period.

**To find rarely used services:** a project without a service appears as "No API services", and a project with a service but without requests, as "No requests in this period". Ascending order by requests puts these first. In the error and latency columns, whoever has no requests always stays at the end, in both directions.

**Reading:** `getApiOverview` in `src/lib/data/operator/api.ts`.

- One query brings the active projects, the number of non-archived services and the last rolled-up hour of each one.
- Each project gets its own stretches through the **same** `metricSources` as the tenant dashboard, and they go to the database in a JSON (`json_to_recordset`; the driver does not serialize text arrays in this query).
- A second query sums 1d, 1h and 1m per project, only for non-archived services, and computes the percentiles over the summed histograms.

**Choices:**

- **Per project, not per service**, as #38 asks. The number of services is in the table; the detail per service is in the tenant's own dashboard.
- **An archived service does not count**, as in the tenant dashboard, where it answers 404.
- **No change against the previous period**, for the same reason as #37.
- **A removed or pending project does not appear** (E2 spec, section 6).

**Tests:** `test/operator-api.test.ts`:

- sum of the services, with traps for double counting, partial day, rolled-up hour inside the slack, period, archived service and removed project;
- late job in one of the projects;
- **the global dashboard shows the same numbers as the sum of the dashboards of each service** (requests, 4xx and 5xx) in 24 hours, 7 and 30 days and 12 months, and the same percentiles with a single service;
- page: default order, ascending, by 5xx with the empty ones at the end, filter, unknown values in the URL and 404 for a project member.

The isolation suite (`isolation.test.ts`) checks the dashboard's 404 for a project member.

**Checked that the tests catch failures:** counting an archived service, ignoring the last rolled-up hour, including a removed project and letting the hours stretch invade the minutes one make tests fail. The last one only started failing after a new trap row (rolled-up hour inside the slack); before that, the mutation survived.

**Checked in the browser** with a local operator: desktop and 390px in dark mode, 7 and 30 days, ascending order. The test project's numbers match those of its dashboard.

## 4. Limits and pending items

- **If the job from #34 stays stopped for more than 35 days** (the retention of `api_metric_1m`), the hours not rolled up are lost. Until then, the dashboard reads from `api_metric_1m`. Monitoring of the job comes in with production's internal metrics (ADR 0005).
- **The endpoints table** brings all the route and method pairs of the period before cutting at 100. With the cap of 500 routes per service and day, it fits; if it grows, it becomes a query with `LIMIT`. Monitoring of the job comes in with production's internal metrics (ADR 0005).
