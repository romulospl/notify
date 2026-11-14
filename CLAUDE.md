# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é o projeto

Plataforma open source e multi-tenant de **analytics web e de API** para projetos do ecossistema Stellar, proposta para o RFP "Web and API Analytics for Stellar Ecosystem Projects" do Stellar Community Fund (SCF). Cada projeto (tenant) vê só os próprios dados; operadores do SCF têm visão global e comparativa.

## Estado atual

O monorepo tem a estrutura do ADR 0002 (issue #11). O código de aplicação até agora é o **portal** (`apps/portal`), com o E2 feito até onde dá sem o coletor (login, tenants, cadastro self-service, chaves de ingestão, operador SCF, remoção de projeto e suíte de isolamento; a #20 e a #21 só esperam a parte do coletor, #30; ver `docs/e2-implementacao.md`), o **script de rastreamento** (`packages/tracker`, issue #22), os **painéis web** do tenant (`/sites/[siteId]`, issue #28) e do SCF (`/operator/web`, issue #29), ver `docs/e4-implementacao.md`, o **gateway de ingestão web** (`services/ingest-web`, issue #61), os **exemplos de integração** (`examples/`, issue #27) e o começo do **coletor de API** (`services/collector`: #30, #32) e das **tabelas de métricas** (#33). As outras pastas têm só um `README.md` dizendo o que vai nela e qual issue a cria.

- **TypeScript:** pnpm workspaces (`apps/*`, `packages/*`, `examples/*`) + Turborepo. Comandos na raiz: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (todos via `turbo run`).
- **Go:** um módulo só em `services/` (`github.com/romulospl/notify/services`, Go 1.26). Rodar `go` de dentro de `services/`: `gofmt -l .`, `go mod tidy -diff`, `go vet -tags e2e ./...` e `go test -race ./...` (o CI roda os quatro). Testes ponta a ponta levam a tag `e2e` e rodam no job `compose`.
- **Versões novas:** o `pnpm-workspace.yaml` tem `minimumReleaseAge: 20160` (14 dias), então o pnpm recusa releases mais novas que isso. Fixe versões exatas no `package.json`.

- **Ambiente local:** `docker compose up -d --wait` na raiz sobe PostgreSQL 17 (bancos `umami` e `notify`, cada um com usuário próprio) e Umami 3.4.1 só na rede interna (`http://umami:3000`, login `admin`/`umami`; nenhuma porta publicada, #62). Para a interface, o script da conta de serviço ou o e2e do gateway, inclua o override `-f compose.yaml -f infra/compose/umami-port.yaml`, que publica em `127.0.0.1:3001` e é só para desenvolvimento e CI. O `compose.yaml` da raiz só inclui `infra/compose/dev.yaml`. Imagens fixadas por tag **e digest**; os scripts de `infra/compose/postgres/init/` só rodam com o volume vazio, então mudanças neles exigem `docker compose down -v` (o `02-ingest-roles.sh` é idempotente e pode ser reaplicado com `docker compose exec -T postgres sh < ...`). As migrações do portal exigem os usuários `notify_ingest` e `notify_collector` criados por esse script; o job `typescript` do CI roda o mesmo script antes dos testes. Portas e senhas podem ser trocadas num `.env` (ver `.env.example`). Cada serviço próprio entra no `dev.yaml` na issue que o cria. O portal já está lá (porta 3000), com `RUN_MIGRATIONS=true`, o gateway `ingest-web` (porta 3002) e o coletor (portas 4317 e 4318).

- **CI:** `.github/workflows/ci.yml`, jobs `typescript`, `go`, `compose` e o agregador `ci` (a `main` não tem proteção de branch por decisão do Romulo; se for ligada, exigir só o `ci`). Testes de integração usam o Postgres do job pela variável `DATABASE_URL` (`postgresql://notify:notify@localhost:5432/notify`). Actions sempre fixadas por SHA com a tag em comentário, e só releases com pelo menos 14 dias. Valide mudanças no workflow com `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`. Job novo precisa entrar no `needs` do `ci`.
- **Produção (#14, ADR 0004):** Hetzner Cloud (`nbg1`), **OpenTofu** em `infra/opentofu/` (não Terraform: licença BUSL), Ansible em `infra/ansible/` (só `ansible.builtin`), `infra/compose/prod.yaml` com Caddy (`infra/caddy/Caddyfile`) e Postgres Debian com WAL-G (`infra/compose/postgres/Dockerfile`, `notify-backup`, `notify-restore`). Passo a passo e restauração em `docs/deploy.md`. O job `infra` do CI valida a IaC e roda `infra/compose/test/prod-stack-test.sh` (rotas do Caddy, portas, backup cifrado e restauração com S3 local). Serviço novo entra no `prod.yaml` e, se público, no Caddyfile; o Umami nunca. Administração pelo túnel `infra/scripts/admin-tunnel.sh`. Monitoramento externo (#15, ADR 0005) em `infra/monitoring/` (Prometheus, blackbox, Alertmanager), numa VM separada em `fsn1`, deploy por `infra/ansible/monitoring.yml`; testado pelo job `monitoring` (`infra/monitoring/test/monitoring-test.sh`). Monte pastas, não arquivos, nos contêineres: o Ansible troca arquivos por renomeação. Para rodar OpenTofu localmente, use o contêiner `ghcr.io/opentofu/opentofu:1.13.2` (o nome `tofu` conflita com o rtk no shell).
- **Release e dependências:** `.github/workflows/release.yml` roda ao publicar uma release; gera SBOM e publica, assina (cosign keyless) e atesta uma imagem para cada `Dockerfile` em `apps/*/` ou `services/*/` (o nome da imagem é o da pasta, e o contexto do build é a raiz do repositório). O `renovate.json` impõe 14 dias de espera, exige aprovação no Dependency Dashboard para versões maiores e trata o Umami à parte; o `docker-compose` manager lê `infra/compose/*.yaml`. Valide mudanças com `npx --yes --package renovate -- renovate-config-validator --strict renovate.json`.

## Portal (`apps/portal`)

- Next.js 16 (App Router, `src/proxy.ts` no lugar do antigo `middleware.ts`), Better Auth com Drizzle, Tailwind 4, Vitest. Interface em inglês; comentários e docs em português.
- Toda página privada pega um contexto de `src/lib/access.ts`: `requireTenantContext()` (ou `getTenantContext()`, que devolve nulo para quem ainda não tem projeto) ou `requireOperatorContext()`. `requireSession()` (`src/lib/session.ts`) só serve para dados da própria sessão, como o e-mail no cabeçalho. O `proxy.ts` é só um redirecionamento otimista e **não** substitui essa checagem.
- **Isolamento (ADR 0003, #18):** o tenant vem sempre da sessão, nunca de valor do cliente. Todo acesso ao banco fica em `src/lib/data/` (funções do operador em `src/lib/data/operator/`) e todo acesso ao Umami em `src/lib/umami/`, sempre recebendo um contexto (tipo marcado, só `access.ts` cria). O ESLint proíbe importar o cliente do banco, o driver e o cliente HTTP do Umami fora dessas pastas (`eslint.config.mjs`, testado em `test/lint-boundaries.test.ts`); o esquema (`db/schema`) é liberado. Recurso de outro tenant responde 404: a função de `data/` devolve nulo e a página chama `notFound()`. Rotas do tenant não levam o ID do tenant na URL; só as de `/operator` aceitam `tenantId`. O portal cria só sites no Umami, sem usuários nem equipes.
- Variáveis lidas por `src/lib/env.ts`; no `next build` ele usa valores inertes, então não acesse o banco em tempo de build.
- Esquema em `src/lib/db/schema.ts` (colunas em snake_case); depois de mudar, `pnpm db:generate --name <descricao>` e commite o SQL de `drizzle/`. Visões, GRANTs e gatilhos vão em migração escrita à mão (`pnpm db:generate --custom --name <descricao>`), como a `0002_ingest_views.sql`.
- **Umami (#58):** só `src/lib/umami/` chama o Umami (lint proíbe importar `umami/http` fora dali). A conta de serviço é um usuário comum do Umami com chave de API em `UMAMI_API_KEY`, gerada por `pnpm umami:service-account` (senha de admin só nesse script). Nos testes, `server-only` é trocado por um stub no `vitest.config.ts` e o Umami é falso (`test/fake-umami.ts`). Prefira `127.0.0.1:3001` a `localhost:3001` para o Umami (com o override): se outro programa escutar a porta em IPv6, `localhost` cai nele.
- **Umami fechado (#62):** sem porta publicada e sem rota no Caddy; gravação de sessão e heatmaps desligados (o portal nunca manda `replayConfig`, o gateway não repassa `/api/record`). Detalhes e o teste em `docs/umami.md`. O Umami roda sem patch; qualquer patch vai documentado lá.
- **Painel web (#28):** `/sites/[siteId]`, lido por `getSiteDashboard` (`src/lib/umami/stats.ts`), que confere o site do tenant antes de chamar o Umami. Períodos fixos em UTC em `src/lib/period.ts` (valor desconhecido na URL vira 7 dias), formatação em `src/lib/format.ts`. No `/metrics` do Umami 3.4.1, o `y` conta visitantes, não visualizações. Páginas tratam `UmamiError` importando de `umami/stats` (o lint proíbe `umami/http` e `umami/read`, que lê pelo ID do Umami sem conferir o tenant). O Umami falso responde `/stats`, `/pageviews` e `/metrics` e tem `down` para simular falha.
- **Painel web do SCF (#29):** `/operator/web`, lido por `getWebOverview` e `compareProjects` (`src/lib/umami/overview.ts`), com os sites de `listActiveTenantSites` (só projetos ativos; IDs da URL nunca chegam ao Umami sem passar por essa lista). Só `/stats` por site na tabela, no máximo 8 chamadas simultâneas. Estado todo na URL (GET).
- **Chaves de ingestão (#59):** formato e hash em `src/lib/ingest-key.ts` (contrato com o coletor), funções em `src/lib/data/api-services.ts`, telas em `/services`. A chave completa só existe no retorno da criação: nunca em log, banco ou mensagem de erro. Os testes de integração deixam linhas no `audit_log`, que só aceita inserção.
- **Operador SCF (#19):** só nasce por `pnpm operator:create|promote|demote` (`scripts/operator.mjs`, grava no `audit_log`); `pnpm user:create` cria só usuário comum. D2 garantido também por gatilho no banco (migração 0003). Telas em `/operator` e `/operator/tenants/[tenantId]`, funções em `src/lib/data/operator/`. Seed: `pnpm db:seed` (senha em `SEED_PASSWORD`).
- **Remoção de projeto (#20):** `removeTenant`/`reactivateTenant` em `src/lib/data/operator/tenants.ts` são as únicas escritas do operador; gravam status, quem, motivo e uma linha no `audit_log`. A ingestão não muda: as visões `ingest_site` e `ingest_key_active` já exigem tenant `active`.
- **Isolamento (#21):** a suíte da seção 8 do spec fica em `test/isolation.test.ts` (páginas e server actions com sessão simulada, mais as visões lidas como `notify_ingest`/`notify_collector` por `test/helpers/as-role.ts`). Painel novo (#28, #37) acrescenta casos ali; o coletor (#30) troca os `it.todo`. ID de outro tenant em server action responde 404 (`notFound()`), como nas páginas.
- **Cadastro self-service (#17):** `/sign-up` → e-mail → `/onboarding` (cria o tenant e o `owner`, `src/lib/data/tenants.ts`, contexto `requireOnboardingContext()`) → `/sites` e `/services`. `requireTenantContext()` leva quem não tem projeto a `/onboarding`.
- **Cadastro e e-mail (#60):** cadastro aberto em `/sign-up`, com confirmação de e-mail obrigatória (sem confirmar, não entra nem cria projeto). Recuperação de senha em `/forgot-password` (link de 30 minutos, uso único, encerra as sessões). Limites por IP em `customRules` de `src/lib/auth.ts`. E-mail só em texto puro, por `src/lib/mail.ts` e `SMTP_URL`; no Compose vai para o Mailpit (`http://127.0.0.1:8025`). Nos testes, `vi.mock("@/lib/mail")` captura as mensagens. Usuários de teste já confirmados: `pnpm user:create` (senha em `PORTAL_USER_PASSWORD`).
- A sessão não guarda IP (`databaseHooks` em `src/lib/auth.ts`); a telemetria do Better Auth e do Next fica desligada.
- TypeScript fixado em 6.0 e ESLint em 9, porque os plugins do `eslint-config-next` ainda não aceitam TypeScript 7 nem ESLint 10.

## Script de rastreamento (`packages/tracker`)

- TypeScript empacotado com esbuild em `n.js` (IIFE). A lógica fica em `src/tracker.ts` e a entrada em `src/index.ts`; os scripts de `scripts/` rodam direto no Node (`.ts`, sem build).
- **Versão publicada é imutável:** `published/vX.Y.Z/n.js` mais o hash em `published/sri.json`, tudo commitado. Mudou o código? Suba a `version` do `package.json` e rode `pnpm --filter @notify/tracker release`; ele se recusa a sobrescrever uma versão existente. O teste `test/published.test.ts` falha se um arquivo publicado mudar ou se o código atual não bater com a versão do `package.json`. Isso inclui atualização do esbuild que mude o resultado, então ela também exige versão nova.
- Desde a v1.1.0 o script pede o desafio em `GET /c` e resolve a prova com `crypto.subtle` antes de enviar (só em HTTPS ou `localhost`); a v1.0.0 não tem prova e o gateway descarta os eventos dela.
- O gateway (#61) serve `published/` em `/s/`. O script manda `POST /e` para a origem de onde foi carregado, com `Content-Type: text/plain` (para evitar o preflight de CORS; o corpo é JSON) e `credentials: "omit"`.
- Da query string saem só os `utm_*`, e o referenciador vai sem query nem fragmento.
- **Ad blockers (#23):** `pnpm --filter @notify/tracker check:adblock [host...]` baixa EasyList, EasyPrivacy, as listas padrão do uBlock Origin e a de Peter Lowe e falha se alguma bloquear `/s/vX.Y.Z/n.js`, `/e` ou `/c`. Roda no workflow próprio `.github/workflows/adblock.yml` (PRs que mexem no script ou nas rotas, `main` e todo dia), fora do agregador `ci`, porque as listas mudam sem mudança no código. Resultado e recomendação de host neutro em `packages/tracker/docs/ad-blockers.md`.

## Gateway web (`services/ingest-web`)

- `main.go` só monta a configuração e o servidor; rotas em `handler.go`; pacotes em `internal/` (`config`, `clientip`, `limit`, `site`, `relay`). Detalhes de rotas, respostas e variáveis no `README.md` da pasta.
- Rotas: `POST /e` (JSON com `Content-Type` `text/plain` ou `application/json`, CORS aberto e sem cookie), `GET /c` (desafio da prova de JS), `GET /s/` (arquivos de `SCRIPT_DIR`, cache imutável de um ano) e `GET /healthz`.
- **Prova de execução de JS (#25):** pacote `internal/proof`. `GET /c?s=<website>` devolve um token assinado com HMAC (`PROOF_SECRET`); o script acha um nonce com `PROOF_BITS` bits zero no SHA-256 e manda `p:{t,n}` em cada evento. Sem prova válida, `204` e descarte. A prova nunca é repassada ao Umami. Nos testes Go, `proof.Solve` faz o papel do script.
- O payload repassado ao `UMAMI_URL/api/send` é montado de novo só com `website`, `hostname`, `url`, `referrer`, `title`, `language` e `screen`. Nunca repasse `ip`, `userAgent`, `id` ou `timestamp` do cliente: o Umami aceitaria e o cliente poderia trocar IP ou sessão.
- Ao Umami só chegam `Content-Type`, o `User-Agent` original e o IP **já truncado** (`clientip.Truncate`) no header de `CLIENT_IP_HEADER`. O `X-Forwarded-For` só vale vindo de `TRUSTED_PROXIES`.
- **Fingerprints por IP (#26):** pacote `internal/fingerprint`. Hash de UA, `Accept-Language`, idioma e tela, só em memória. Por IP truncado e site (a conta separada por site impede um tenant de lotar a cota dos outros), aceita até `FINGERPRINT_LIMIT` fingerprints distintas numa janela deslizante (`FINGERPRINT_WINDOW`); as novas além disso recebem `204` e são descartadas. Ordem no `POST /e`: prova de JS, `ingest_site`, fingerprints e repasse.
- **Contrato `ingest_site`** (spec do E2, seções 4 e 6): o gateway conecta como `notify_ingest` e só lê `ingest_site(umami_website_id, accepts_ingest)`, criada pela migração `apps/portal/drizzle/0002_ingest_views.sql`. Site recusado recebe a mesma resposta do sucesso (`204`) e o evento é descartado; o cache é de no máximo 1 minuto.
- **Privacidade (#24):** nenhum log leva IP, `X-Forwarded-For` ou `User-Agent`; nenhuma resposta grava cookie. O e2e `services/ingest-web/e2e/privacy_test.go` varre as colunas de texto dos bancos `umami` e `notify` atrás do IP completo e confere que a geolocalização usa o IP truncado. Ele exige que o gateway confie no `X-Forwarded-For` do teste (`INGEST_TRUSTED_PROXIES`, definido no job `compose` do CI).
- A imagem é `scratch` (sem shell); o healthcheck é `ingest-web -healthcheck`. Ela copia `packages/tracker/published` para `/scripts` quando a pasta existe.

## Coletor de API (`services/collector`)

- Contrato no `docs/specs/e5-pipeline-de-api.md`. Componentes Go em `services/collector/components/`, um pacote por componente.
- **Distribuição (#30):** manifesto do OCB em `collector/builder-config.yaml` (Collector v0.164.0 / core v1.70.0), código gerado e commitado em `collector/cmd/notify-collector` por `collector/generate.sh` (o OCB cria um `go.mod` próprio; o script copia só os `.go` para o módulo `services`). O job `go` do CI regenera e falha se houver diferença. Todos os módulos `go.opentelemetry.io/collector/...` sobem juntos, na mesma release e com 14 dias; cuidado com o `go mod tidy`, que puxa a mais nova. Configuração em `collector/config.yaml`; no Compose, serviço `collector` em `127.0.0.1:4317` (gRPC) e `4318` (HTTP).
- **Autenticação (#30):** extensão `components/ingestkeyauth`, `Authorization: Bearer ntf_...` em HTTP e gRPC, busca pelo prefixo na `ingest_key_active` como `notify_collector`, SHA-256 em tempo constante, cache de no máximo 60 s (`INGEST_KEY_CACHE_TTL`). Recusa com 401 / Unauthenticated. O processor `components/tenantattr` (antes do `batch`) grava `notify.tenant.id` e `notify.api_service.id` da chave e apaga o que o cliente mandou com esses nomes. A chave completa nunca vai para log.
- **Testes Go com banco:** `services/internal/pgtest` dá um banco com as migrações do portal (temporário, com `CREATEDB`; senão o já migrado) sem nunca migrar o de `DATABASE_URL`. Feche a conexão com `t.Cleanup`, não `defer`, para as limpezas rodarem antes.
- **Normalização de rotas (#32):** `components/routenorm`, `Route(httpRoute, path)`. O `http.route` do cliente vale como veio; sem ele, segmentos viram `{uuid}`, `{address}` (StrKey G/C de 56 ou M de 69 caracteres, sem conferir checksum), `{hash}` (16+ hex, com ou sem `0x`) ou `{id}` (só dígitos), nessa ordem. Tira query, fragmento, barras repetidas e a final; corta em 256 bytes no fim de um segmento. Tem fuzz (`go test -fuzz FuzzPath ./collector/components/routenorm`), com os casos achados em `testdata/fuzz`.

## Métricas de API (banco `notify`)

- Contrato no `docs/specs/e5-pipeline-de-api.md`, seção 4. Migração escrita à mão `apps/portal/drizzle/0004_api_metrics.sql` (#33), testada em `apps/portal/test/api-metrics.test.ts`.
- `api_metric_1m` (gravada pelo coletor), `api_metric_1h` e `api_metric_1d` (job da #34): mesmas colunas, chave `(tenant_id, api_service_id, route, method, status_code, bucket_start)`, particionadas por mês em UTC (`<tabela>_pYYYYMM`) com partição `<tabela>_default`. `api_metric_ensure_partitions(meses)` cria as partições que faltam e move para elas as linhas da default.
- `duration_buckets` tem 15 posições, com os limites de `api_metric_bounds()` (buckets do OTel para `http.server.request.duration`, em segundos, mais um acima de 10 s). Percentil: `api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.95)`; no `ON CONFLICT`, some com `api_metric_add_buckets`.
- `notify_collector` tem `SELECT`, `INSERT` e `UPDATE` só em `api_metric_1m`.

## Exemplos (`examples/`)

- `static-html`, `spa` e `nextjs-ssr` instalam o script como um tenant faria; `examples/README.md` tem os trechos de instalação usados no guia de onboarding (#43). HTML e SPA sobem com `examples/serve.mjs`, que troca `<!-- notify:script -->` pela tag (site em `NOTIFY_WEBSITE_ID`).
- `examples/e2e` (Playwright): `pnpm --filter @notify/examples-e2e e2e` cria os sites no Umami e no banco `notify`, abre os três exemplos num Chromium e confere os page views no banco do Umami. Roda no job `compose` do CI. O script se chama `e2e`, não `test`, para o turbo não rodá-lo no job `typescript`.

## Onde está o planejamento

- **Decisões de arquitetura:** `docs/adr/` (índice em `docs/adr/README.md`). Leia os ADRs 0001 e 0002 antes de propor mudanças de stack ou de estrutura, e o 0003 antes de mexer em acesso a dados.
- **Andamento:** `docs/andamento.md` (resumo, commits e próximos passos) e `docs/e2-implementacao.md` (o que foi feito no E2, escolhas e pendências). Atualize os dois ao fechar issues.
- **Specs:** `docs/specs/`, um por épico que tem contrato entre componentes. O spec fixa o contrato (tabelas, papéis, formatos); decisão com alternativas vai para ADR. Antes de implementar qualquer issue do E2 (#16–#21, #58–#60), leia `docs/specs/e2-tenants-e-controle-de-acesso.md`. Antes de implementar issue do E5 (#30–#36), leia `docs/specs/e5-pipeline-de-api.md` (normalização de rotas, tabelas de métricas, buckets e retenção). O spec do E3 não foi escrito; o contrato do E3 está no `CLAUDE.md` e nos READMEs do gateway e do script.
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
