# Self hosting

stellytics runs on one Linux server with Docker Compose. Everything needed is in the repository.

## What runs

- **Caddy** for HTTPS, the **portal**, the **web gateway**, the **API collector**, a **rollup** job, **Umami** and **Postgres**.
- Continuous, encrypted Postgres backups to an S3-compatible bucket.
- External monitoring and alerts from a second, small host.

## What you need

- A Debian or Ubuntu server, open only on ports 22, 80 and 443.
- Four DNS names: portal, portal alias, gateway and collector.
- An S3-compatible bucket and an SMTP service.
- A second host for monitoring.

## Install

```bash
sudo ./init.sh
sudo nano .env.production
sudo ./deploy.sh
```

The [deploy guide](../deploy.md) has every step, plus how to check, update, back up and restore.

## Operate

- [Runbooks](../runbooks/README.md) for incidents, backups, secret rotation, vulnerabilities and Umami upgrades.
- [Handover](../handover.md) for passing the instance to a new operator.
- [Security policy](../../SECURITY.md) for reporting vulnerabilities.
