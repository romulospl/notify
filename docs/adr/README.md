# Architecture Decision Records (ADR)

Record of the project's architecture decisions. Each ADR describes the context, the decision, the alternatives considered and the consequences.

## Index

| No. | Title | Status | Date |
|---|---|---|---|
| [0001](0001-ferramenta-base.md) | Umami as the base tool for web analytics | Accepted | 13/11/2026 |
| [0002](0002-arquitetura-e-stack.md) | Product architecture and stack | Accepted (IaC superseded by 0004) | 13/11/2026 |
| [0003](0003-isolamento-no-portal.md) | Tenant isolation is the portal's responsibility | Accepted | 13/11/2026 |
| [0004](0004-hospedagem-e-backup.md) | Hosting on Hetzner, OpenTofu and backup with WAL-G | Accepted; main proxy superseded by 0013 and restored by 0014 | 14/11/2026 |
| [0005](0005-monitoramento-externo.md) | External monitoring with Prometheus, on a separate VM | Accepted | 14/11/2026 |
| [0006](0006-api-de-leitura-do-scf.md) | SCF read API with operator keys | Accepted | 15/11/2026 |
| [0007](0007-cadastro-com-aprovacao.md) | Sign-up with prior approval | Accepted | 15/11/2026 |
| [0008](0008-eventos-customizados-e-wallets-kit.md) | Custom events in the script and Stellar Wallets Kit capture | Accepted | 15/11/2026 |
| [0009](0009-alta-disponibilidade.md) | High availability for the SLA targets | Proposed | 15/11/2026 |
| [0010](0010-adaptador-opt-in-do-wallets-kit.md) | Opt-in Stellar Wallets Kit adapter | Accepted | 15/11/2026 |
| [0011](0011-limite-de-repasses-ao-umami.md) | Limit on concurrent relays from the gateway to Umami | Proposed | 15/11/2026 |
| [0012](0012-ingestao-de-api-pelo-caddy.md) | API ingestion in production through Caddy, on port 443 | Restored by 0014 | 16/11/2026 |
| [0013](0013-nginx-no-host.md) | Nginx on the host as the production proxy | Superseded by 0014 | 18/11/2026 |
| [0014](0014-infra-em-docker-compose.md) | Production infrastructure on Docker Compose | Accepted | 18/11/2026 |
| [0015](0015-optional-rfp-features.md) | Adopting the optional RFP features: custom events and wallets | Accepted | 19/11/2026 |

## How to write a new ADR

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, with the next number.
2. Fill in the sections and open a PR.
3. Add the row to the index above.
4. An accepted ADR is not rewritten: if the decision changes, create a new ADR and mark the old one as `Superseded by NNNN`.

Possible statuses: `Proposed`, `Accepted`, `Rejected`, `Obsolete`, `Superseded by NNNN`.
