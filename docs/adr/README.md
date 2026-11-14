# Architecture Decision Records (ADR)

Registro das decisões de arquitetura do projeto. Cada ADR descreve o contexto, a decisão, as alternativas consideradas e as consequências.

## Índice

| Nº | Título | Status | Data |
|---|---|---|---|
| [0001](0001-ferramenta-base.md) | Umami como ferramenta base de analytics web | Aceito | 13/11/2026 |
| [0002](0002-arquitetura-e-stack.md) | Arquitetura e stack do produto | Aceito (IaC substituída pelo 0004) | 13/11/2026 |
| [0003](0003-isolamento-no-portal.md) | Isolamento entre tenants é responsabilidade do portal | Aceito | 13/11/2026 |
| [0004](0004-hospedagem-e-backup.md) | Hospedagem na Hetzner, OpenTofu e backup com WAL-G | Aceito | 14/11/2026 |

## Como escrever um novo ADR

1. Copie [`template.md`](template.md) para `NNNN-titulo-curto.md`, com o próximo número.
2. Preencha as seções e abra um PR.
3. Adicione a linha no índice acima.
4. ADR aceito não é reescrito: se a decisão mudar, crie um novo ADR e marque o antigo como `Substituído por NNNN`.

Status possíveis: `Proposto`, `Aceito`, `Rejeitado`, `Obsoleto`, `Substituído por NNNN`.
