# 0015. Production on an existing EC2 instance

- **Status:** Proposed
- **Date:** 19/11/2026
- **Issue:** #52

## Context

ADR 0004 places production on Hetzner Cloud with OpenTofu, Ansible and WAL-G backups. The production that the project was told about runs instead on an AWS EC2 instance with Docker, using the minimal VPS path (`infra/compose/prod-vps.yaml`, #159), which has no external backup. Issue #52 needs host recovery and backups for that instance. The actual topology still has to be confirmed with whoever operates the AWS account.

## Decision

While production runs on that EC2 instance, add host recovery and daily backups with the CloudFormation stack in `infra/aws/ec2-recovery.yaml`, and a daily logical dump of both databases (`infra/aws/pg-dump.sh`) taken before the snapshot. The Hetzner path of ADR 0004 stays as the documented alternative; this ADR does not replace it. CloudFormation is used because it only touches AWS resources around an instance created outside the repository; OpenTofu would need to import or reference it as well.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Snapshot only | Simplest | Crash-consistent copy of a running Postgres |
| WAL-G to S3 (as in ADR 0004) | Point-in-time recovery, small RPO | Needs the custom Postgres image and S3 credentials on the host; larger change than #52 needs now |
| OpenTofu with the AWS provider | One IaC tool | Instance is not managed by the repository; import and state handling for three resources |

## Consequences

- RPO of up to one day, more if a backup fails; no point-in-time recovery.
- Backups keep deleted personal data for up to 30 days (plus 7 days of local dumps); recorded in `docs/privacidade.md`. Region and EU residency of the instance are not verified.
- The alarms cover host and guest failures of one instance; they do not raise availability above a single VM (ADR 0009).
- Nothing was applied or rehearsed in the AWS account; `docs/runbooks/ensaio-recuperacao-aws.md` describes the drill.
