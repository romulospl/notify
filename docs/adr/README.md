# Architecture Decision Records (ADR)

Registro das decisões de arquitetura do projeto. Cada ADR descreve o contexto, a decisão, as alternativas consideradas e as consequências.

## Índice

| Nº | Título | Status | Data |
|---|---|---|---|
| [0001](0001-ferramenta-base.md) | Umami como ferramenta base de analytics web | Aceito | 13/11/2026 |
| [0002](0002-arquitetura-e-stack.md) | Arquitetura e stack do produto | Aceito (IaC substituída pelo 0004) | 13/11/2026 |
| [0003](0003-isolamento-no-portal.md) | Isolamento entre tenants é responsabilidade do portal | Aceito | 13/11/2026 |
| [0004](0004-hospedagem-e-backup.md) | Hospedagem na Hetzner, OpenTofu e backup com WAL-G | Aceito; proxy principal substituído por 0013 e retomado por 0014 | 14/11/2026 |
| [0005](0005-monitoramento-externo.md) | Monitoramento externo com Prometheus, numa VM separada | Aceito | 14/11/2026 |
| [0006](0006-api-de-leitura-do-scf.md) | API de leitura do SCF com chaves de operador | Aceito | 15/11/2026 |
| [0007](0007-cadastro-com-aprovacao.md) | Cadastro com aprovação prévia | Aceito | 15/11/2026 |
| [0008](0008-eventos-customizados-e-wallets-kit.md) | Eventos customizados no script e captura do Stellar Wallets Kit | Aceito | 15/11/2026 |
| [0009](0009-alta-disponibilidade.md) | Alta disponibilidade para as metas de SLA | Proposto | 15/11/2026 |
| [0010](0010-adaptador-opt-in-do-wallets-kit.md) | Adaptador opt-in do Stellar Wallets Kit | Aceito | 15/11/2026 |
| [0011](0011-limite-de-repasses-ao-umami.md) | Limite de repasses simultâneos do gateway ao Umami | Proposto | 15/11/2026 |
| [0012](0012-ingestao-de-api-pelo-caddy.md) | Ingestão de API em produção pelo Caddy, na porta 443 | Retomado por 0014 | 16/11/2026 |
| [0013](0013-nginx-no-host.md) | Nginx no host como proxy da produção | Substituído por 0014 | 18/11/2026 |
| [0014](0014-infra-em-docker-compose.md) | Infraestrutura de produção em Docker Compose | Aceito | 18/11/2026 |

## Como escrever um novo ADR

1. Copie [`template.md`](template.md) para `NNNN-titulo-curto.md`, com o próximo número.
2. Preencha as seções e abra um PR.
3. Adicione a linha no índice acima.
4. ADR aceito não é reescrito: se a decisão mudar, crie um novo ADR e marque o antigo como `Substituído por NNNN`.

Status possíveis: `Proposto`, `Aceito`, `Rejeitado`, `Obsoleto`, `Substituído por NNNN`.
