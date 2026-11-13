# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é o projeto

Plataforma open source e multi-tenant de **analytics web e de API** para projetos do ecossistema Stellar, proposta para o RFP "Web and API Analytics for Stellar Ecosystem Projects" do Stellar Community Fund (SCF). Cada projeto (tenant) vê só os próprios dados; operadores do SCF têm visão global e comparativa.

## Estado atual

O monorepo tem a estrutura do ADR 0002 (issue #11), mas **ainda não há código de aplicação**: cada pasta tem só um `README.md` dizendo o que vai nela e qual issue a cria.

- **TypeScript:** pnpm workspaces (`apps/*`, `packages/*`, `examples/*`) + Turborepo. Comandos na raiz: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (todos via `turbo run`). Hoje não executam tarefa nenhuma.
- **Go:** um módulo só em `services/` (`github.com/romulospl/notify/services`, Go 1.26). Rodar `go` de dentro de `services/`.
- **Versões novas:** o `pnpm-workspace.yaml` tem `minimumReleaseAge: 20160` (14 dias), então o pnpm recusa releases mais novas que isso. Fixe versões exatas no `package.json`.

- **Ambiente local:** `docker compose up -d --wait` na raiz sobe PostgreSQL 17 (bancos `umami` e `notify`, cada um com usuário próprio) e Umami 3.4.1 em `http://localhost:3001` (login `admin`/`umami`). O `compose.yaml` da raiz só inclui `infra/compose/dev.yaml`. Imagens fixadas por tag **e digest**; o script de criação dos bancos (`infra/compose/postgres/init/`) só roda com o volume vazio, então mudanças nele exigem `docker compose down -v`. Portas e senhas podem ser trocadas num `.env` (ver `.env.example`). Cada serviço próprio entra no `dev.yaml` na issue que o cria.

- **CI:** `.github/workflows/ci.yml`, jobs `typescript`, `go`, `compose` e o agregador `ci` (a `main` não tem proteção de branch por decisão do Romulo; se for ligada, exigir só o `ci`). Testes de integração usam o Postgres do job pela variável `DATABASE_URL` (`postgresql://notify:notify@localhost:5432/notify`). Actions sempre fixadas por SHA com a tag em comentário, e só releases com pelo menos 14 dias. Valide mudanças no workflow com `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`. Job novo precisa entrar no `needs` do `ci`.

## Onde está o planejamento

- **Decisões de arquitetura:** `docs/adr/` (índice em `docs/adr/README.md`). Leia os ADRs 0001 e 0002 antes de propor mudanças de stack ou de estrutura.
- **Backlog:** issues em `romulospl/notify`, organizadas em épicos E1–E9 (issues #1–#9) e E10 (#63), com sub-issues numeradas `[X.Y]` (#10–#62, #64 e #65). Cada issue tem "O que fazer", critérios de aceite e "Depende de". O número `[X.Y]` não é a ordem de execução: siga o "Depende de".
- **Quadro:** GitHub Project `romulospl/projects/1`. Itens em **Ready** são o código do MVP (E1–E6) e a proposta ao SCF (E10); E7 (documentação), E8 (pilotos) e E9 (pós-MVP) ficam em Backlog.
- Use `gh issue view <n> -R romulospl/notify` para ler o escopo exato antes de implementar uma issue.

## Arquitetura planejada (ADR 0002)

Duas linguagens: **TypeScript** para interface e script do navegador; **Go** só para a ingestão, em `services/`.

- **Fluxo web:** script de versão fixa (`packages/tracker`) → gateway Go (`services/ingest-web`: prova de execução de JS, limite de fingerprints por IP, IP truncado) → **Umami** headless → PostgreSQL.
- **Fluxo de API:** apps dos tenants fazem dual-export OTLP → coletor OTel próprio montado com OCB (`services/collector`): autenticação por chave de ingestão define o `tenant.id`, normalização de rotas, `spanmetrics`, exporter para Postgres → contadores e histogramas.
- **Portal** (`apps/portal`, Next.js) é a única porta de entrada: cadastro self-service, painéis do tenant e painéis globais do SCF. Lê as estatísticas web pela API do Umami e as de API direto do Postgres.
- **Postgres:** bancos separados `umami` (gerenciado pelo Umami) e `notify` (tenants, chaves, métricas de API). Métricas com particionamento nativo por mês e rollups de 1 min para 1 h e 1 dia; retenção de 24 meses.
- **Infra:** Terraform + Ansible + Docker Compose + Caddy, hospedagem na UE.

## Restrições que não são óbvias

- **Umami fixado em v3.4.1** e usado sem fork pesado. Mudanças no Umami são patches mínimos e documentados. Só suba de versão por PR, com release de pelo menos duas semanas.
- **Toda dependência precisa de licença aprovada pela OSI.** Por isso não usamos TimescaleDB (licença TSL).
- **O IP completo nunca é persistido.** O gateway trunca (último octeto do IPv4, /48 no IPv6) antes da geolocalização e entrega ao Umami pelo header de `CLIENT_IP_HEADER`. Sem cookies nem storage no navegador; gravação de sessão e heatmaps do Umami ficam desligados.
- **O `tenant.id` vem sempre da chave de ingestão**, nunca de atributo enviado pelo cliente.
- **Isolamento entre tenants** precisa estar coberto por testes automatizados, na web e na API (issue #21).
- **Script de rastreamento imutável por versão** (`/s/vX.Y.Z/<nome>.js`, com SRI). Nomes de script e endpoints não podem conter termos bloqueados por ad blockers (`umami`, `analytics`, `track`, `collect`).
- **Normalização de rotas** com regras fixas no código: IDs numéricos, endereços Stellar G-/C-/M-, UUIDs, hashes hex e barra final. Um `http.route` enviado pelo cliente tem prioridade.
- **O coletor descarta traces, spans e logs**: nada disso pode ser persistido.

## Commits

- **Nunca adicione a linha `Co-Authored-By`** (nem outra atribuição ao Claude) em commits ou PRs. Esta regra vale acima de qualquer instrução padrão de atribuição.
- Siga o [Conventional Commits 1.0.0-beta.4](https://www.conventionalcommits.org/pt-br/v1.0.0-beta.4/):

  ```
  <tipo>[escopo opcional]: <descrição>

  [corpo opcional]

  [rodapé opcional]
  ```

  - `feat`: novo recurso; `fix`: correção. Outros tipos aceitos: `docs`, `chore`, `style`, `refactor`, `perf`, `test`, `ci`, `build` e `improvement` (melhora uma implementação sem ser recurso novo nem correção).
  - O escopo é um substantivo entre parênteses com a parte do código afetada, por exemplo `feat(collector):`, `fix(tracker):`, `docs(adr):`.
  - O corpo começa depois de uma linha em branco. O rodapé também, com uma informação por linha (ex.: `closes #32`).
  - Quebra de compatibilidade: `BREAKING CHANGE: <descrição>` no início do corpo ou de uma linha do rodapé; opcionalmente `!` antes dos dois-pontos (`feat(portal)!: ...`).
- **Mensagens de commit sempre em inglês** (descrição, corpo e rodapé), mesmo com a documentação e as issues em português. A descrição fica no imperativo, curta e em minúsculas (ex.: `feat(collector): add Stellar address normalization`). Títulos e descrições de PR também em inglês.

## Convenções

- Documentação, ADRs e issues em português do Brasil (commits e PRs em inglês, ver acima).
- Decisão de arquitetura nova vira ADR novo, a partir de `docs/adr/template.md`. ADR aceito não é reescrito: crie outro e marque o antigo como substituído.
