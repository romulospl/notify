# Monthly operations report template

Copy to a file or issue each month. Replace the bracketed fields; use **not measured** for missing data, never zero. Do not publish personal data, secrets or details of vulnerabilities that are still private.

- Period: [inclusive start, exclusive end, UTC]
- Owner and date: [name, date]
- Source, environment and configuration version: [monitor, URLs or identifiers without secrets, version]
- Collection coverage and gaps: [per component; intervals without data are unknown]

| Component | Successes / samples | Observed availability | Estimated downtime | Unknown time | Exclusions and evidence |
|---|---|---|---|---|---|
| Web ingestion | | | | | |
| API ingestion | | | | | |
| Dashboards | | | | | |

Record the times and reasons of exclusions; without an approved decision, also report the raw value. The fraction of samples does not measure the length of each outage precisely: state the probe interval, unknown periods and calculation method. Do not extrapolate gaps as availability or unavailability.

### Prometheus query

In the monitor's Prometheus, evaluate at the UTC instant the following month starts, using the month's length in days (`28d`, `29d`, `30d` or `31d`) and each `component` value: `ingest-web`, `ingest-api` and `portal`. Query both the ratio and the count:

```promql
avg_over_time(probe_success{job="endpoints",component="ingest-web"}[31d])
count_over_time(probe_success{job="endpoints",component="ingest-web"}[31d])
```

Replace `31d` and the component for the period. PromQL ranges are open at the start and closed at the end; watch samples at the month boundary and record the convention used. Identify each series separately if the target changed; do not add averages without weighting by their counts, and do not count overlapping targets twice. With the 15-second interval, compare the count with the expected number of probes and investigate gaps, configuration changes and duplicates. A missing series is neither 100% nor 0%. The 45-day retention must be deployed before collection; save queries, evaluation time and results as evidence. These queries still need validation on the real monitor.

## Incidents and security

| Incident or public reference | Start and end UTC | Impact | Cause, fix and follow-up |
|---|---|---|---|
| | | | |

| Vulnerability or safe reference | Severity | Received or discovered | Fix published | Elapsed time | Status |
|---|---|---|---|---|---|
| | | | | | |

## Support

Requests received: [ ]; resolved: [ ]; pending: [ ]. Give first-response and resolution times, how many met the 5 and 10 business-day targets respectively, and relevant blockers. Mark requests without response or resolution as pending, not as met. State the method and calendar used.

## Actions and decisions

| Action | Owner | Deadline | Reference |
|---|---|---|---|
| | | | |
