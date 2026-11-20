# 0013. Nginx on the host as the production proxy

- **Status:** Superseded by 0014
- **Date:** 18/11/2026
- **Issue:** —

## Context

The main production needs to route portal, web ingestion and OTLP. The proxy in a container shared the Docker network and the production configuration with services that do not need public access. The new composition publishes the required upstreams only on loopback.

## Decision

Use Nginx installed on the host of the main VM as the only public proxy. Nginx terminates TLS with certificates managed by Certbot and forwards to the local ports of the portal, the gateway and the collector. Docker publishes these upstreams on `127.0.0.1`; Umami, Postgres and rollup remain without public ports. The extra ingestion VMs keep Caddy.

The operator provisions DNS and issues the certificate for the four names before running the Ansible playbook. Ansible installs Nginx and Certbot, configures the vhost and installs a hook to reload Nginx after renewal.

This decision supersedes the Caddy proxy of the main VM described in ADR 0004 and the OTLP routing of ADR 0012. The old ADRs remain as a historical record.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Keep Caddy in a container | Automatic TLS and a proxy that is simple to operate | The proxy stays coupled to the network and the lifecycle of the Docker stack |
| Nginx in a container | Declarative configuration and lifecycle managed by Compose | Still depends on publishing container ports and mounting certificates in Docker |
| Nginx on the host | Upstreams bound to loopback and TLS managed by the system's Certbot | The initial certificate requires a manual step before the playbook |

## Consequences

- The public services only accept local connections; the VM's firewall keeps only 22, 80 and 443 open.
- The vhost does not configure an access log; the dedicated error log records only critical errors.
- Issuing the initial certificate is a documented step before Ansible. A hook reloads Nginx on automatic renewals.
- The Nginx configuration is validated with `nginx -t` before reloading the service.
- The local stack checks the Docker upstreams, but does not run Nginx; the vhost validation happens on the VM.
