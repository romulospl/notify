# AWS recovery drill

Goal: check the recovery of data and services and record results for [issue #52](https://github.com/romulospl/stellytics/issues/52). This script is not evidence that a drill ran, nor proof of the availability targets.

## Preparation

1. Identify account, region, instance, volumes, services, deployed version, owner and window. Check costs, limits, permissions and the rollback plan. Confirm that all needed data is in the backup, including the logical dumps from `infra/aws/pg-dump.sh`.
2. Confirm that alerts arrive, that a completed recovery point exists and where the needed secrets are. Do not put secrets in the report.
3. Prepare an isolated environment, without production DNS, without sending email and without write access to production services. Use test data and credentials. Agree on the test before causing any downtime in production.

## Run

1. Record the UTC start time, the recovery point time and the last known event before it. Restore the backup in the isolated environment following [EC2 recovery](../../infra/aws/README.md) and the applicable AWS documentation.
2. Restore the databases from the latest logical dump with `pg_restore` (fall back to the raw data directory only if the dump is unusable). Start the stack and record when services and databases become usable. Check database integrity and reads; a successful snapshot does not guarantee logical consistency.
3. Send a test event through web ingestion and another through the API collector. Confirm acceptance and persistence, and that the expected data shows in the dashboard or the matching read query. Record commands without credentials, and results.
4. Check alerts and host recovery when there is a safe, authorized way to exercise them. An isolated restore does not prove that automatic host recovery works. Do not simulate failures in production without a specific procedure and authorization.
5. Record the end of the drill, remove temporary resources following team policy and open actions for any failures.

## Evidence

- Date, environment, operator, version and references: [ ]
- Scenario exercised and limitations: [ ]
- Start, restored point, last available event, services ready and end, in UTC: [ ]
- Observed data loss and time to recovery: [ ]; explain how they were calculated. Expected RPO/RTO are estimates until a representative measurement.
- Result for databases, web ingestion, API ingestion, dashboard and alerts: [passed/failed/not tested, evidence]
- Failures, owner, deadline and link to the fix: [ ]
