# rollup

Rollup and retention job for the API metrics (#34, E5 spec, section 5). All the logic lives in SQL functions of the migration `apps/portal/drizzle/0005_api_metric_rollup.sql`; this process only schedules the call.

Every `ROLLUP_INTERVAL` it runs, as `stellytics` (owner of the tables), `api_metric_maintain(ROLLUP_LOOKBACK)`, which:

1. creates the monthly partitions for the current month and the next two (`api_metric_ensure_partitions(2)`);
2. rolls up the closed hours (ended at least 5 minutes ago) of `api_metric_1m` into `api_metric_1h`, and the days of those hours into `api_metric_1d` (`api_metric_rollup`), replacing the values with the recomputed sum (idempotent);
3. drops the expired partitions (`api_metric_drop_partitions`): `api_metric_1m` 35 days after the end of the month, `api_metric_1h` and `api_metric_1d` 25 months after.

| Variable | Default | Use |
|---|---|---|
| `DATABASE_URL` | (required) | `stellytics` database, as the `stellytics` user |
| `ROLLUP_INTERVAL` | `15m` | Interval between runs (the first one runs at startup) |
| `ROLLUP_LOOKBACK` | `48h` | How far back to roll up again on each run (minimum `2h`); covers late batches and the job being stopped for up to that long |
| `LISTEN_ADDR` | `:8080` | `GET /healthz`: 200 if the last successful run is at most two intervals old |

`scratch` image; the healthcheck is `rollup -healthcheck`. If it stays stopped longer than `ROLLUP_LOOKBACK`, roll up again by hand: `SELECT api_metric_rollup(now() - interval '7 days');`.
