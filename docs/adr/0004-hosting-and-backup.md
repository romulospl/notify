# 0004. Hosting on Hetzner, OpenTofu and backup with WAL-G

- **Status:** Superseded by 0016 (WAL-G backup kept)
- **Date:** 14/11/2026
- **Issue:** [#14](https://github.com/romulospl/stellytics/issues/14)
- **Depends on:** [ADR 0002](0002-architecture-and-stack.md)

## Context

ADR 0002 fixed the shape of production: one VM in the European Union, Terraform for the VM, the firewall and the DNS, Ansible for the deploy with Docker Compose, Caddy for TLS and continuous Postgres backup (WAL-G or pgBackRest) to object storage. The provider, the location, the backup tool and some details that only show up when writing the IaC were left open.

Constraints that weigh:

- **every dependency needs an OSI-approved license** (CLAUDE.md);
- another community team must be able to recreate production with only the repository and the secrets;
- the MVP fits in one VM (ADR 0002), and the cost has to be low, because the product is free for tenants and for the SCF;
- the data must have declared residency in the EU.

## Decision

1. **Hetzner Cloud, in Nuremberg (`nbg1`), Germany.** The VM, the data volume and the backup's Object Storage are in the same location. The location is a variable (`nbg1`, `fsn1` or `hel1`), all in the EU with Object Storage.
2. **OpenTofu in place of Terraform.** Terraform moved to the BUSL license from version 1.6 onwards, which is not OSI-approved. OpenTofu (MPL-2.0) is the fork maintained by the Linux Foundation, reads the same `.tf` files and uses the same providers. This replaces only the tool from ADR 0002; the rest still holds.
3. **What OpenTofu creates** (`infra/opentofu/`): the VM, the Hetzner firewall (SSH only from the administration networks; 80 and 443 open), a separate volume for the data, the SSH key and the backup bucket. The volume and the bucket have deletion protection.
4. **DNS outside the IaC for now.** The domain does not exist yet. The portal and ingestion hosts are variables, and OpenTofu shows the IPs for the A and AAAA records. When there is a domain, the record can go into the IaC with the provider of the chosen DNS.
5. **Backup with WAL-G**, inside the Postgres image (`infra/compose/postgres/Dockerfile`):
   - continuous WAL through `archive_command`, with an `archive_timeout` of 60 seconds;
   - daily base backup by a systemd timer, keeping the 7 newest;
   - brotli compression and **client-side encryption** (libsodium), with the key kept outside the VM;
   - restore up to the last WAL or up to a point in time (`stellytics-restore`), tested in CI on every PR with the commands from `docs/deploy.md`.
6. **Deploy with Ansible**, with `ansible.builtin` modules only, without extra collections. The deploy checks the signature of each image with cosign before bringing it up, against the identity of the release workflow.
7. **Production Postgres on the Debian variant** (`postgres:17.11-bookworm`), with the same version as the local environment (which uses Alpine): the WAL-G binaries use glibc.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Scaleway (France) | Official provider, S3 Object Storage, managed Postgres | More expensive for a single VM |
| OVHcloud (France) | Large European company | IaC through the OpenStack provider, more verbose |
| Terraform | Better known | BUSL license, not OSI-approved |
| pgBackRest | More features (parallel backup, verification) | More configuration (repository, stanza) with no gain for a single VM |
| The provider's managed Postgres | Ready-made backup | Leaves our own PostgreSQL and Compose; ties us to the provider and makes the handover harder |
| DNS in the IaC right away | Full recreation in one command | There is no domain or chosen DNS provider yet |

## Consequences

- **Data residency:** the VM, the volume with Postgres and the backups are in Germany (`nbg1`). The full IP is never stored (ADR 0002), and the backups leave the VM encrypted.
- **Recreating from scratch** requires only the repository and the secrets (Hetzner token, Object Storage keys, passwords and the backup key); the step-by-step is in [`docs/deploy.md`](../deploy.md).
- **The backup key (`WALG_LIBSODIUM_KEY`) is critical:** without it, no backup can be restored. It stays in the team's password vault, outside the VM.
- **WAL-G limits found:** with a low `WALG_DOWNLOAD_FILE_RETRIES`, the retry counter goes negative and it retries forever (v3.0.9). The default (15 attempts) stays as it is.
- **Privacy in the logs:** Caddy does not write the IP, headers or URL of requests to any log, not even the error logs (which it writes even without an access log).
- **Mandatory volume:** the volume is mounted with `nofail`, so that the VM boots even without it, but Docker and the backup require `/srv/stellytics` to be mounted (`RequiresMountsFor`). Without this, a reboot with the volume missing would create an empty database on the VM's disk, and retention would end up deleting the good backups.
- **IPv6:** the Compose network has IPv4 and IPv6, because with `userland-proxy` off Caddy only serves the AAAA record this way. The gateway trusts the `X-Forwarded-For` from Caddy's two fixed IPs.
- **Restore:** `stellytics-restore` discards the recovery targets that come inside a backup taken after another restore. To go back to a point in time, the starting point is the last backup completed before it (`docs/deploy.md`).
- **Single points of failure:** the VM and the volume. High availability is left for post-MVP ([#52](https://github.com/romulospl/stellytics/issues/52)).
- **Upgrading versions:** images and binaries pinned by digest or hash (Postgres, Caddy, Umami, WAL-G, cosign, OpenTofu and providers). Renovate covers the Compose files and the Dockerfiles; WAL-G and cosign are updated by hand, checking the release hash.
