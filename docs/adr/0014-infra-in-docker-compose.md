# 0014. Production infrastructure in Docker Compose

- **Status:** Accepted
- **Date:** 18/11/2026
- **Issue:** —

## Context

Production needs to be installable on a VPS that offers Docker, without requiring a proxy, a certificate manager or application services installed directly on the host. ADR 0013 moved the main proxy to Nginx on the host, which prevented this fully container-based deployment.

## Decision

All application services, including the public proxy, run in Docker Compose. Caddy is the only container that publishes ports to the internet (80 and 443), obtains and renews TLS certificates automatically and forwards traffic to the portal, the ingestion gateway and the collector over the internal Docker network. Postgres keeps its publication limited to the VPS loopback for administration through an SSH tunnel. Umami and rollup do not publish ports.

The persistent state and the Caddy certificates live in `${STELLYTICS_DATA_DIR:-/srv/stellytics}/caddy`. The firewall keeps accepting only administrative SSH, HTTP and HTTPS. Ansible installs/configures Docker, copies the Compose file, the Caddyfile and the `.env`, verifies the image signatures and starts the stack.

This decision supersedes ADR 0013 and reinstates the routing through Caddy of ADR 0012. ADR 0013 remains as a historical record.

## Consequences

- DNS for the four hosts and ports 80/443 need to be available before the first start so that Caddy can issue certificates.
- TLS installation and renewal now follow the lifecycle of the Caddy container; its data must be preserved in backups and in VPS migrations.
- Caddy does not write access logs and filters request fields in the error logs.
- The CI Compose stack validates routes, TLS, port exposure, OTLP proxy, backup and restore. The first deployment on a real account still needs to be supervised.
