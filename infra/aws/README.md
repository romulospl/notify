# Production EC2 recovery

Decision: [ADR 0015](../../docs/adr/0015-producao-em-ec2.md). Not yet applied or validated in the production account.

`ec2-recovery.yaml` is a CloudFormation stack that adds, to the EC2 instance already running Docker:

- recovery to healthy hardware after two failed system checks (`StatusCheckFailed_System`) and a reboot after three failed instance checks (`StatusCheckFailed_Instance`), both with email notice;
- a daily AWS Backup of the instance at 03:00 UTC, kept for `RetentionDays` (default 30, maximum 35) in a vault encrypted with a dedicated KMS key, with recovery point deletion denied to everyone but the account root;
- an email when a backup job fails, is aborted or expires.

Before deploying, confirm that the instance type and tenancy support recovery, that Docker starts on boot and that every Compose volume and `/var/backups/stellytics` are on EBS. Alarms, snapshots, KMS and restores are billed. See the [EC2 recovery requirements](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/cloudwatch-recovery.html).

```sh
aws cloudformation deploy --template-file infra/aws/ec2-recovery.yaml \
  --stack-name stellytics-recovery --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides InstanceId="$INSTANCE_ID" OperationsEmail="$OPS_EMAIL"
```

Confirm the SNS subscription email.

## Database consistency

A snapshot of a running Postgres is only crash-consistent. `pg-dump.sh` writes a logical dump of `stellytics` and `umami` before the snapshot, so each recovery point carries one; keep 7 days locally by default (`KEEP_DAYS`). Install it in the host's cron:

```sh
echo '30 2 * * * root cd /opt/stellytics && infra/aws/pg-dump.sh >> /var/log/stellytics-pg-dump.log 2>&1' | sudo tee /etc/cron.d/stellytics-pg-dump
```

The recovery point objective is up to one day of events, more if a backup fails. There is no point-in-time recovery here, unlike the WAL-G setup of the Hetzner path (ADR 0004).

## Retention and privacy

Recovery points and local dumps keep personal data (account emails, password hashes, sessions, events with truncated IPs) after an account or project is deleted, for up to `RetentionDays` (30 by default) plus `KEEP_DAYS`. See [`docs/privacidade.md`](../../docs/privacidade.md).

## Restore drill and recovery checks

After the first backup, restore the recovery point on an isolated EC2 instance, without production DNS and without outbound SMTP, following the [recovery drill](../../docs/runbooks/ensaio-recuperacao-aws.md). Prefer restoring from the logical dump with `pg_restore`; use the raw data directory only as a fallback.

After an alarm, check the outcome in AWS Health, run `docker compose --env-file .env.production -f infra/compose/prod-vps.yaml ps` and check web ingestion, the OTLP collector and the portal externally. The alarms cover host and guest failures only: application failures, loss of an availability zone and database recovery need other measures.
