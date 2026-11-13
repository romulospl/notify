# notify

Plataforma open source e multi-tenant de **analytics web e de API** para projetos do ecossistema [Stellar](https://stellar.org), proposta para o RFP *Web and API Analytics for Stellar Ecosystem Projects* do [Stellar Community Fund](https://communityfund.stellar.org) (SCF).

> **Estado:** em desenvolvimento inicial. O monorepo já tem a estrutura de pastas e as decisões de arquitetura; os componentes entram pelas issues do épico [E1](https://github.com/romulospl/notify/issues/1) em diante.

## O problema

O SCF não tem uma fonte confiável e unificada de dados de uso dos projetos que financia. Hoje os revisores dependem de números informados pelos próprios projetos para decidir quem entra em programas de continuidade.

O notify oferece uma plataforma compartilhada e gratuita em que:

- cada projeto (tenant) mede o uso do seu site e da sua API e vê só os próprios dados;
- operadores do SCF veem e comparam as métricas de todos os projetos.

## O que a plataforma mede

**Web**, coletando só no frontend, sem cookies e sem dado pessoal:

- visualizações de página e visitantes únicos;
- referenciadores;
- duração da sessão e taxa de rejeição;
- país, dispositivo e navegador.

**API**, a partir do OpenTelemetry que o projeto já envia ao próprio APM (dual-export):

- volume de requisições por endpoint normalizado;
- distribuição de status code;
- latência p50 e p95.

O coletor descarta traces, spans e logs e guarda só contadores e histogramas.

## Arquitetura

```mermaid
flowchart LR
  subgraph Tenant
    B[Navegador<br/>script de versão fixa]
    A[API do tenant<br/>OpenTelemetry]
  end

  subgraph notify
    G[Gateway de ingestão web<br/>Go]
    U[Umami<br/>headless]
    C[Coletor OTel<br/>Go]
    P[Portal<br/>Next.js]
    PG[(PostgreSQL)]
  end

  B -->|evento + prova de JS| G
  G -->|IP truncado| U
  A -->|OTLP| C
  U --> PG
  C -->|contadores e histogramas| PG
  P --> U
  P --> PG
  T[Tenant e operador SCF] --> P
```

| Componente | Stack | Papel |
|---|---|---|
| Portal | Next.js | Cadastro self-service, painéis do tenant e painéis globais do SCF |
| Script de rastreamento | TypeScript | Versão fixa e imutável, com SRI e nome que ad blockers não bloqueiam |
| Gateway de ingestão web | Go | Anti-bot (prova de execução de JS, limite de fingerprints por IP) e truncamento do IP |
| [Umami](https://umami.is) v3.4.1 | Next.js | Motor de analytics web, usado sem fork |
| Coletor de API | OpenTelemetry Collector + componentes Go | Autenticação por chave, normalização de rotas e gravação das métricas |
| Banco | PostgreSQL | Analytics web e métricas de API, com retenção de 24 meses |
| Infra | Terraform, Ansible, Docker Compose, Caddy | Hospedagem na União Europeia, recriável a partir deste repositório |

Os detalhes e as alternativas descartadas estão nos ADRs:

- [0001 — Umami como ferramenta base](docs/adr/0001-ferramenta-base.md)
- [0002 — Arquitetura e stack](docs/adr/0002-arquitetura-e-stack.md)

## Estrutura do repositório

```
apps/
  portal/            Portal Next.js: cadastro, painéis do tenant e do SCF
packages/
  tracker/           Script de rastreamento (TypeScript, esbuild)
services/            Módulo Go único (go.mod)
  ingest-web/        Gateway de ingestão web
  collector/         Coletor OpenTelemetry (manifesto do OCB)
    components/      Autenticação por chave, normalização de rotas, exporter Postgres
infra/               Terraform, Ansible, Docker Compose, Caddy e monitoramento
examples/            Integrações de referência (HTML, SPA, SSR, backend com OTel)
docs/                ADRs e registro de andamento
```

Cada pasta tem um `README.md` com o papel dela e a issue que a cria.

- **TypeScript:** pnpm workspaces (`apps/*`, `packages/*`, `examples/*`) e Turborepo. O pnpm só instala versões publicadas há pelo menos 14 dias (`minimumReleaseAge` no `pnpm-workspace.yaml`).
- **Go:** um módulo só, em `services/`.

### Requisitos e comandos

Node.js 24 ou mais novo, pnpm 10 (ative com `corepack enable`) e Go 1.26.

```bash
pnpm install
pnpm build      # turbo run build
pnpm lint
pnpm test
```

Os comandos ainda não executam tarefas: elas aparecem conforme os pacotes forem criados.

### Ambiente local (Docker Compose)

Requer Docker com o Compose v2. Na raiz do repositório:

```bash
docker compose up -d --wait
```

A primeira subida cria os bancos `umami` e `notify` e aplica as migrações do Umami, sem passo manual.

| Serviço | Endereço | Acesso |
|---|---|---|
| Umami v3.4.1 | http://localhost:3001 | usuário `admin`, senha `umami` (padrão do Umami; só local) |
| PostgreSQL 17 | `localhost:5432` | `postgres`/`postgres` (superusuário), `umami`/`umami` e `notify`/`notify`, cada um dono do seu banco |

- Para mudar portas ou senhas, copie `.env.example` para `.env` e edite.
- `docker compose down` para os serviços e mantém os dados. `docker compose down -v` apaga o volume, e a próxima subida recria os bancos do zero.
- Os arquivos ficam em [`infra/compose/`](infra/compose/). Portal, gateway e coletor entram no Compose nas issues que os criam.

### Integração contínua

O workflow [`ci.yml`](.github/workflows/ci.yml) roda em todo push na `main` e em todo PR:

| Job | O que faz |
|---|---|
| `typescript` | `pnpm install --frozen-lockfile` (falha se o lockfile estiver desatualizado), `lint`, `typecheck`, `test` e `build`, com Postgres disponível em `DATABASE_URL` |
| `go` | `gofmt`, `go mod tidy -diff`, `go vet` e `go test -race` em `services/`, também com Postgres |
| `compose` | Sobe o ambiente local com `docker compose` e confere os bancos e o Umami |
| `ci` | Agrega os anteriores em um resultado só. A `main` não tem proteção de branch, então o check não bloqueia merge; se a proteção for ligada, é este o check a exigir |

As actions são fixadas por SHA, com a tag em comentário.

### Cadeia de suprimentos

- **Dependências travadas:** `pnpm-lock.yaml` e `services/go.sum` commitados; o CI falha com lockfile ausente ou desatualizado.
- **Espera de 14 dias:** o pnpm recusa versões mais novas (`minimumReleaseAge`) e o [Renovate](renovate.json) só abre PR para releases com pelo menos 14 dias. O Umami nunca é atualizado em grupo nem automaticamente. Versões maiores só viram PR depois de aprovadas no Dependency Dashboard (um issue mantido pelo Renovate); correções de segurança passam direto.
- **Release:** ao publicar uma release no GitHub (tag `vX.Y.Z`), o workflow [`release.yml`](.github/workflows/release.yml) anexa um SBOM (SPDX, gerado com syft) e, para cada `Dockerfile` em `apps/*` e `services/*`, publica a imagem em `ghcr.io/romulospl/notify/<nome>`, assinada com cosign (keyless) e com o SBOM da imagem como atestado.

Para verificar uma imagem publicada:

```bash
cosign verify ghcr.io/romulospl/notify/<nome>:<versão> \
  --certificate-identity-regexp '^https://github.com/romulospl/notify/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Para conferir o SBOM atestado, troque `verify` por `verify-attestation --type spdxjson` no mesmo comando.

## Privacidade

A meta é conformidade com a GDPR **sem banner de consentimento**:

- **IP:** o último octeto do IPv4 (ou o equivalente no IPv6) é descartado antes da geolocalização. O IP completo nunca é gravado.
- **Navegador:** nenhum cookie, `localStorage` ou identificador persistente.
- **Umami:** gravação de sessão e heatmaps ficam desligados.
- **Dados:** ficam armazenados na União Europeia.

## Roadmap

O backlog está nas [issues](https://github.com/romulospl/notify/issues), organizado em épicos, e no [quadro do projeto](https://github.com/users/romulospl/projects/1).

| Épico | Escopo |
|---|---|
| [E1](https://github.com/romulospl/notify/issues/1) | Fundação do monorepo e infraestrutura |
| [E2](https://github.com/romulospl/notify/issues/2) | Multi-tenant, cadastro e controle de acesso |
| [E3](https://github.com/romulospl/notify/issues/3) | Coleta de analytics web |
| [E4](https://github.com/romulospl/notify/issues/4) | Painéis de analytics web |
| [E5](https://github.com/romulospl/notify/issues/5) | Pipeline de analytics de API (OpenTelemetry) |
| [E6](https://github.com/romulospl/notify/issues/6) | Painéis de analytics de API |
| [E7](https://github.com/romulospl/notify/issues/7) | Documentação, privacidade e conformidade |
| [E8](https://github.com/romulospl/notify/issues/8) | Pilotos com projetos reais do SCF |
| [E9](https://github.com/romulospl/notify/issues/9) | Pós-MVP: SLA, escala, chaves de API e transferência |

## Contribuindo

O guia completo está no [`CONTRIBUTING.md`](CONTRIBUTING.md), e vulnerabilidades são relatadas como descrito no [`SECURITY.md`](SECURITY.md). Dúvidas e bugs vão para as [issues](https://github.com/romulospl/notify/issues/new/choose), que são o canal público de suporte.

- Commits seguem o [Conventional Commits 1.0.0-beta.4](https://www.conventionalcommits.org/pt-br/v1.0.0-beta.4/), por exemplo `feat(collector): add Stellar address normalization`.
- Decisões de arquitetura novas viram um ADR em [`docs/adr/`](docs/adr/README.md), a partir do [template](docs/adr/template.md).

## Licença

[MIT](LICENSE).
