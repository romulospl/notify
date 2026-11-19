# Andamento do projeto

Registro do que já foi feito, das decisões tomadas e dos próximos passos. Atualizado em **16/11/2026**.

## Resumo

| Item | Situação |
|---|---|
| Escopo do MVP | Definido a partir do RFP (seção [MVP](#1-mvp-definido-a-partir-do-rfp)) |
| Backlog | 10 épicos e 55 issues no GitHub (#1–#65), revisado em 13/11/2026 |
| Quadro do projeto | 16 itens em Done, 3 em In progress, 27 em Ready e 19 em Backlog |
| Ferramenta base | **Umami v3.4.1** ([ADR 0001](adr/0001-ferramenta-base.md)) |
| Arquitetura e stack | Definidas ([ADR 0002](adr/0002-arquitetura-e-stack.md)) |
| Repositório | Estrutura do monorepo (#11), ambiente local com Docker Compose (#12), CI (#13), Renovate e releases assinadas (#55), IaC da produção na Hetzner (#14, [ADR 0004](adr/0004-hospedagem-e-backup.md)) |
| Código | Portal com o E2 completo. No E4, painéis web do tenant (#28) e do SCF (#29), detalhados em [`e4-implementacao.md`](e4-implementacao.md), detalhado em [`e2-implementacao.md`](e2-implementacao.md). No E6, painéis de API do tenant (#37) e do SCF (#38), em [`e6-implementacao.md`](e6-implementacao.md). No E3, script de rastreamento (#22) e gateway de ingestão (#61) |

## 1. MVP definido a partir do RFP

Fonte: documento `rfp1-web-api-analytics-poc.md`, que resume o RFP *Web and API Analytics for Stellar Ecosystem Projects* do Stellar Community Fund (consultado em 13/11/2026).

O MVP foi definido como a menor versão que **projetos-piloto reais** (3 com analytics web e 1 com analytics de API) conseguem usar e que o SCF consegue consultar. Ficou de fora o que é operação de 12 meses, escala ou transferência.

### Entra no MVP

1. **Base e multi-tenant:**
   - Umami sobre PostgreSQL;
   - cadastro self-service;
   - isolamento estrito com testes;
   - operador SCF com visão global;
   - remoção de projeto pelo operador.
2. **Coleta web:**
   - script com versão fixa e SRI;
   - nomes que ad blockers não bloqueiam;
   - anti-bot: prova de execução de JS e limite de fingerprints por IP;
   - privacidade: IP truncado, sem cookies e sem dado pessoal;
   - exemplos de instalação para HTML estático, SPA e SSR.
3. **Painéis web:**
   - painel do tenant com as 7 métricas mínimas (visualizações, visitantes únicos, referenciadores, duração da sessão, rejeição, país, dispositivo e navegador);
   - painel global comparativo do SCF.
4. **Pipeline de API:**
   - coletor OTLP com chave de ingestão, que descarta traces, spans e logs;
   - normalização de rotas com testes;
   - contadores e histogramas no Postgres;
   - agregação com retenção de 24 meses;
   - guia de dual-export.
5. **Painéis de API:**
   - painel do tenant com volume, status code e p50/p95 por endpoint;
   - painel global do SCF.
6. **Monorepo e operação mínima:** licença OSI, IaC, CI com testes, documentação mínima e monitoramento básico.
7. **Prova de uso:** 3 pilotos web, 1 piloto de API e vídeo da experiência do tenant.

### Fica para depois do MVP

- SLA de 99,99% e 99,9% e alta disponibilidade
- Escala de 1 milhão de requisições por dia (validar com teste de carga)
- Chaves de API do SCF para outros sistemas consumirem as métricas
- Cadastro com aprovação prévia (o modelo já prevê o status `pendente`)
- Fluxo de apagamento (dispensável enquanto não houver dado pessoal guardado)
- Eventos customizados e captura automática do Stellar Wallets Kit
- Runbooks completos e transferência para outra equipe

## 2. Backlog no GitHub

Repositório: [romulospl/stellytics](https://github.com/romulospl/stellytics/issues).

- **Épicos:** E1–E9 são as issues #1–#9; o E10 é a #63.
- **Issues:**
  - numeradas `[X.Y]` (#10–#62, #64 e #65), cada uma ligada ao seu épico como **sub-issue**;
  - cada uma tem "O que fazer", critérios de aceite em checklist e "Depende de", com links;
  - o número `[X.Y]` identifica a issue dentro do épico, mas **não é a ordem de execução**: vale o "Depende de" (a [2.7] vem antes da [2.1], por exemplo).
- **Labels:**
  - `epic`;
  - uma por épico (`E1: Fundação`, `E2: Multi-tenant` etc.);
  - `mvp` nas issues dos épicos E1 a E8;
  - `pos-mvp` nas issues do E9;
  - as issues do E10 levam só `E10: Proposta`.

| Épico | Issues | Escopo |
|---|---|---|
| [#1 E1](https://github.com/romulospl/stellytics/issues/1) | #10–#15, #55, #56 | Fundação do monorepo e infraestrutura |
| [#2 E2](https://github.com/romulospl/stellytics/issues/2) | #16–#21, #57–#60 | Multi-tenant, cadastro e controle de acesso |
| [#3 E3](https://github.com/romulospl/stellytics/issues/3) | #22–#27, #61, #62 | Coleta de analytics web |
| [#4 E4](https://github.com/romulospl/stellytics/issues/4) | #28–#29 | Painéis de analytics web |
| [#5 E5](https://github.com/romulospl/stellytics/issues/5) | #30–#36 | Pipeline de analytics de API (OpenTelemetry) |
| [#6 E6](https://github.com/romulospl/stellytics/issues/6) | #37–#38 | Painéis de analytics de API |
| [#7 E7](https://github.com/romulospl/stellytics/issues/7) | #39–#43 | Documentação, privacidade e conformidade |
| [#8 E8](https://github.com/romulospl/stellytics/issues/8) | #44–#47 | Pilotos e prova de adoção |
| [#9 E9](https://github.com/romulospl/stellytics/issues/9) | #48–#54 | Pós-MVP |
| [#63 E10](https://github.com/romulospl/stellytics/issues/63) | #64, #65 | Proposta e submissão ao SCF |

### Revisão de 13/11/2026

O backlog foi comparado com o RFP e com o ADR 0002. A cobertura do RFP estava completa, mas faltavam issues para peças centrais e várias issues eram anteriores ao ADR 0002.

- **Issues criadas:**
  - portal: [#57](https://github.com/romulospl/stellytics/issues/57) (esqueleto e login), [#58](https://github.com/romulospl/stellytics/issues/58) (conta de serviço no Umami), [#59](https://github.com/romulospl/stellytics/issues/59) (chaves de ingestão) e [#60](https://github.com/romulospl/stellytics/issues/60) (verificação de e-mail);
  - gateway: [#61](https://github.com/romulospl/stellytics/issues/61) (o serviço) e [#62](https://github.com/romulospl/stellytics/issues/62) (Umami só na rede interna, gravação de sessão e heatmaps desligados);
  - fundação: [#55](https://github.com/romulospl/stellytics/issues/55) (cadeia de suprimentos aplicada) e [#56](https://github.com/romulospl/stellytics/issues/56) (`SECURITY.md`, `CONTRIBUTING.md` e modelos de issue);
  - proposta: épico [#63](https://github.com/romulospl/stellytics/issues/63), com [#64](https://github.com/romulospl/stellytics/issues/64) (Interest form e código de indicação) e [#65](https://github.com/romulospl/stellytics/issues/65) (redigir a proposta).
- **Texto corrigido:** #11, #12, #14, #18, #19, #20, #28 e #41.
- **Dependências ou critérios corrigidos:** #16, #17, #23, #24, #25, #27, #30 e #37.
- **Mudanças que valem lembrar:**
  - a #12 passou a subir só Postgres e Umami; cada serviço próprio entra no Compose na issue que o cria, e o seed de 2 tenants e 1 operador foi para a #19;
  - a #18 assume que o isolamento é responsabilidade do portal, porque a conta de serviço do Umami enxerga todos os sites. O tenant é sempre resolvido pela sessão, em uma camada única de acesso a dados.

## 3. Quadro do projeto

Quadro: [GitHub Project 1](https://github.com/users/romulospl/projects/1/views/1).

Contagem conferida em 13/11/2026, no fim do dia:

- **Done (16):** inclui, do E2, as issues #16, #17, #18, #19, #57, #58, #59 e #60.
- **In progress (3):** inclui o épico E2 (#2).
- **Ready (27):** as issues de código do MVP que faltam, entre elas #20 e #21 do E2, e as da proposta (#64 e #65).
- **Backlog:** os épicos E7, E8 e E9 e o que ainda resta das issues #42–#54 (guias aguardando teste de fora, pilotos e pós-MVP).

## 4. Decisões

### Umami como ferramenta base ([ADR 0001](adr/0001-ferramenta-base.md))

Dados conferidos no GitHub em 13/11/2026:

- **Licença:** o Umami é MIT. O GoatCounter usa uma EUPL 1.2 modificada, que formalmente não é a licença aprovada pela OSI.
- **Atividade:** o Umami tem releases mensais e equipe de mantenedores. O GoatCounter depende essencialmente de uma pessoa.
- **Banco e equipes:** o Umami v3 roda só em PostgreSQL (o banco que o RFP exige) e já tem equipes e vários sites.
- **Versão:** fixada em **v3.4.1**. A v3.5.0 saiu em 12/11/2026, e a regra é só adotar release com pelo menos duas semanas.

**Consequências:**
- O Umami não tem cadastro aberto, então o cadastro fica no portal.
- O painel comparativo e as métricas de API também ficam no portal.
- Gravação de sessão e heatmaps precisam ficar desligados.

### Arquitetura e stack ([ADR 0002](adr/0002-arquitetura-e-stack.md))

- **TypeScript:**
  - portal em Next.js (cadastro, painéis do tenant e painéis globais);
  - script de rastreamento próprio.
- **Go**, só na ingestão:
  - gateway web (anti-bot e truncamento do IP);
  - coletor OpenTelemetry montado com OCB, com autenticação por chave, normalização de rotas e exporter para Postgres.
- **PostgreSQL:**
  - bancos `umami` e `stellytics`;
  - particionamento nativo por mês e rollups de 1 min para 1 h e 1 dia;
  - sem TimescaleDB, por causa da licença TSL.
- **Infra:** Terraform, Ansible, Docker Compose e Caddy, com hospedagem na União Europeia.

### Isolamento no portal ([ADR 0003](adr/0003-isolamento-no-portal.md)) e spec do E2

O portal lê o Umami com uma conta de serviço que enxerga tudo, então o isolamento entre tenants é responsabilidade só do portal. O contrato está no [spec do E2](specs/e2-tenants-e-controle-de-acesso.md), aceito em 13/11/2026 com seis decisões:

- **D1:** um usuário pertence a um único tenant.
- **D2:** operador SCF não é membro de tenant.
- **D3:** não há papel de administrador; operador é criado por script.
- **D4:** um usuário de banco por serviço (`stellytics`, `stellytics_ingest`, `stellytics_collector`).
- **D5:** o serviço de API vem da chave de ingestão; o `service.name` do cliente é ignorado.
- **D6:** o operador pode reativar um tenant removido.

**Consequência para o ADR 0001:** o portal cria só sites no Umami, sem usuários nem equipes.

**Specs:** só os épicos com contrato entre componentes têm spec (E2, E3 e E5). Os do E3 e do E5 serão escritos ao começar cada épico.

## 5. Arquivos do repositório

| Arquivo | Conteúdo |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | Contexto para o Claude Code: arquitetura, restrições não óbvias, padrão de commits (Conventional Commits 1.0.0-beta.4, sem `Co-Authored-By`) |
| [`README.md`](../README.md) | Visão do projeto, métricas, arquitetura, privacidade, roadmap e contribuição |
| [`docs/adr/`](adr/README.md) | Índice, template e ADRs 0001, 0002 e 0003 |
| [`docs/specs/`](specs/e2-tenants-e-controle-de-acesso.md) | Spec do E2: tenants e controle de acesso |
| [`docs/e2-implementacao.md`](e2-implementacao.md) | O que foi implementado no E2: issues, escolhas, como rodar, testes e pendências |
| `docs/andamento.md` | Este registro |
| `LICENSE`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `services/go.mod` | Estrutura do monorepo (#11) |
| `compose.yaml`, `infra/compose/`, `.env.example` | Ambiente local com Postgres 17 e Umami 3.4.1 (#12) |
| `.github/workflows/ci.yml` | CI com jobs de TypeScript, Go e Compose (#13) |
| `SECURITY.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/` | Canal de vulnerabilidades, guia de contribuição e modelos de issue (#56) |
| `renovate.json`, `.github/workflows/release.yml` | Renovate e release com SBOM e imagens assinadas (#55) |
| `apps/portal/` | Portal Next.js: login (#57), modelo de tenant (#16), Umami (#58), camada única de dados (#18), chaves de ingestão (#59), cadastro com confirmação de e-mail (#60 e #17) e operador SCF (#19), remoção e reativação de projeto (#20), suíte de isolamento (#21) e painéis web do tenant (#28) e do SCF (#29) |
| `infra/compose/postgres/init/02-ingest-roles.sh` | Usuários `stellytics_ingest` e `stellytics_collector` do banco (#16) |
| `packages/tracker/`, `services/ingest-web/` | Script de rastreamento (#22) e gateway de ingestão web (#61), do E3 |

### Commits na `main` (já no GitHub)

| Commit | Mensagem |
|---|---|
| `847dcad` | `docs(adr): registra a escolha do Umami e a arquitetura do produto` (fechou a #10) |
| `f3a1a60` | `docs: adiciona o README do projeto` (refs #11) |
| `4d56cc2` | `docs: registra o andamento e a revisão do backlog` |
| `09b68d5` | `chore: set up monorepo structure and MIT license` (fechou a #11) |
| `d38c783` | `build(infra): add local docker compose with postgres and umami` (fechou a #12) |
| `9e21e2f` | `ci: add github actions workflow with lint, tests and postgres (#66)` (fechou a #13) |
| `22c37d1` | `docs: add security policy, contributing guide and issue templates (#67)` (fechou a #56) |
| `cdb329a` | `ci: add renovate and signed releases with sbom (#68)` (fechou a #55) |
| `8564748` | `ci(renovate): require dashboard approval for major updates (#69)` |
| `39e8f17` | `feat(portal): add portal skeleton with email and password sign-in (#70)` (fechou a #57) |
| `75658a7` | `docs: add E2 spec and ADR 0003 on tenant isolation` (PR #71) |
| `4eb25c3` | `feat(portal): add tenant data model with ingest views and roles` (PR #71, fechou a #16) |
| `4c3da83` | `feat(portal): add umami service account and site provisioning` (PR #71, fechou a #58) |
| `2f8a2d1` | `feat(portal): enforce single data access layer per tenant` (PR #72, fechou a #18) |
| `9d33fdf` | `feat(portal): add api services and ingest keys` (PR #73, fechou a #59) |
| `73e555a` | `feat(tracker): adiciona script de rastreamento com versão fixa e SRI` (PR #74, fechou a #22) |
| `b986d97` | `feat(ingest-web): adiciona o gateway de ingestão web` (PR #75, fechou a #61) |
| `a6534fa` | `fix(portal): map concurrent duplicate service names to a clear error` (PR #76) |
| `e037b11` | `feat(portal): add email verification and password reset` (PR #76, fechou a #60) |
| `6f0a1cf` | `feat(portal): add self-service project onboarding` (PR #77, fechou a #17) |
| `b262905` | `feat(portal): add scf operator overview and admin commands` (PR #78, fechou a #19) |
| `f83dc69` | `feat(portal): let scf operators remove and reactivate projects` (PR #88, refs #20) |
| `de177f7` | `fix(portal): answer 404 to key actions with another tenant's ids` (PR #88) |
| `f867a3d` | `test: add tenant isolation suite` (PR #88, refs #21) |
| `de8f308` | `docs: record project removal and the isolation suite` (PR #88) |
| `9755566` | `feat(portal): add tenant web dashboard with the seven minimum metrics` (PR #89, fechou a #28) |
| `55d3943` | `docs: record the tenant web dashboard and the umami metrics check` (PR #89) |
| `962ad22` | `feat(portal): add scf web overview with project comparison` (PR #93, fechou a #29) |
| `d0fe1a4` | `docs: record the scf web overview and the commits of PR #89` (PR #93) |
| `f77699d` | `docs(adr): add ADR 0004 on hetzner hosting, opentofu and wal-g backup` (PR #95) |
| `0559c2c` | `feat(infra): add production iac for hetzner with continuous backup` (PR #95, refs #14) |
| `e7ebb77` | `docs: add the production deploy guide and record the iac` (PR #95) |

## 6. Pendências e próximos passos

1. **Concluída:** a [#11 (1.2)](https://github.com/romulospl/stellytics/issues/11), com `LICENSE` (MIT), esqueleto de pastas, pnpm workspaces, Turborepo e `services/go.mod`. Cada pasta tem um `README.md` com o papel dela e a issue que a cria.
2. **Concluída:** a [#12 (1.3)](https://github.com/romulospl/stellytics/issues/12), com Postgres 17.11 e Umami 3.4.1 fixados por digest.
   **Concluída:** a [#13 (1.4)](https://github.com/romulospl/stellytics/issues/13), com CI no GitHub Actions (actions fixadas por SHA, Postgres nos testes e o Compose testado a cada PR). Por decisão de 13/11/2026, a `main` fica **sem proteção de branch**: o CI roda, mas não bloqueia merge nem push direto. Se a proteção for ligada, basta exigir o check `ci`.
   **Concluída:** a [#56 (1.8)](https://github.com/romulospl/stellytics/issues/56), com `SECURITY.md`, `CONTRIBUTING.md` e modelos de issue (bug, dúvida de tenant, pedido de recurso). **Pendência:** o relato privado de vulnerabilidades do GitHub só existe em repositório público; ao abrir o repositório, ligar em *Settings → Code security → Private vulnerability reporting*.
   **Concluída:** a [#55 (1.7)](https://github.com/romulospl/stellytics/issues/55), com Renovate (14 dias de espera) e o workflow de release com SBOM, imagens no GHCR assinadas com cosign e o comando de verificação no README. **Pendência:** instalar o app do Renovate no repositório (github.com/apps/renovate), que é uma ação da conta; sem ele o `renovate.json` não tem efeito.
   **Concluída:** a [#14 (1.5)](https://github.com/romulospl/stellytics/issues/14), produção em VM com Docker como código (14/11/2026 a 19/11/2026). Dois caminhos, ambos com a pilha toda em Docker Compose ([ADR 0014](adr/0014-infra-em-docker-compose.md)): o gerenciado, com Hetzner Cloud em Nuremberg, OpenTofu (no lugar do Terraform, por licença), Ansible, Caddy e backup contínuo com WAL-G cifrado no Object Storage ([ADR 0004](adr/0004-hospedagem-e-backup.md)); e o mínimo, para qualquer VM Debian/Ubuntu já existente (uma EC2 da AWS serve), com `init.sh`, `deploy.sh` e `infra/compose/prod-vps.yaml` (PRs #156 a #159). Passo a passo dos dois em [`deploy.md`](deploy.md). Critérios de aceite:
   - *Recriar servidor, rede, banco, entrada HTTPS e aplicação a partir do monorepo e das variáveis documentadas:* `infra/opentofu/` (VM, firewall, volume, bucket), `infra/ansible/site.yml` e `infra/compose/prod.yaml` com variáveis em `infra/ansible/group_vars` e `secrets.example.yml`; no caminho mínimo, `.env.production.example`, conferido pelo `deploy.sh`.
   - *Declarar onde residem os dados e backups; restaurar um backup e registrar o resultado:* seção "Onde ficam os dados" do `deploy.md` (Nuremberg, Alemanha); restauração (`stellytics-restore`, inclusive para um instante anterior) feita a cada PR pelo `infra/compose/test/prod-stack-test.sh` no job `infra` do CI, com S3 local, e descrita em "Restaurar o banco". O caminho mínimo declara que não tem backup externo.
   - *Verificar o isolamento de Umami e Postgres e os alertas da implantação:* o `prod-stack-test.sh` confere que só o Caddy publica portas, que não há rota para o Umami e que o Postgres só escuta no loopback; os alertas são o monitoramento externo da #15 (job `monitoring` do CI, alerta e resolução por e-mail).

   Validado sem conta real: `tofu validate` e `plan`, `ansible-lint`, playbook numa VM Debian 12 simulada (idempotente) e a pilha de produção no CI a cada PR. Aplicar numa conta real (Hetzner ou AWS), registrar domínio e DNS, escolher o SMTP e publicar a primeira release ficam como operação, fora do código.
   **#15 (1.6), monitoramento externo (14/11/2026):** Prometheus, blackbox e Alertmanager numa VM separada em `fsn1`, testando portal e ingestão web de fora, com alerta por e-mail e sinal de vida opcional ([ADR 0005](adr/0005-monitoramento-externo.md)). Testado no CI (job `monitoring`: alerta e resolvido por e-mail). **Falta:** monitorar a ingestão de API quando o coletor for publicado na produção (E5), e aplicar junto com a #14.
3. **Concluída:** a [#57 (2.7)](https://github.com/romulospl/stellytics/issues/57), esqueleto do portal com login (Better Auth + Drizzle), rotas privadas, imagem Docker e portal no Compose.
   **E2 completo:** concluídas a #16, #58, #18, #59, #60, #17 e #19 em 13/11/2026; em 14/11/2026 a parte do portal da [#20](https://github.com/romulospl/stellytics/issues/20) (remover e reativar projeto) e a [#21](https://github.com/romulospl/stellytics/issues/21) (suíte de isolamento). Com o coletor (#30) na `main`, a #20 fecha com o teste da transição no e2e do coletor (`services/collector/e2e/isolation_test.go`). A #21 fechou com o último caso, "métrica com a chave de A dizendo ser de B é gravada como A", testado no e2e do coletor depois que o exporter ([#31](https://github.com/romulospl/stellytics/issues/31), PR #97) entrou. **Com isso, o E2 está completo.** Detalhes em [`e2-implementacao.md`](e2-implementacao.md).
   **E3:** concluídas a [#22](https://github.com/romulospl/stellytics/issues/22) (script de rastreamento) e a [#61](https://github.com/romulospl/stellytics/issues/61) (gateway de ingestão web), pelos PRs #74 e #75.
   **E4:** em 14/11/2026, a [#28](https://github.com/romulospl/stellytics/issues/28) (painel web do tenant com as 7 métricas, em `/sites/[siteId]`, que também confirmou a pendência do ADR 0001 sobre as métricas do Umami) e a [#29](https://github.com/romulospl/stellytics/issues/29) (painel web global do SCF em `/operator/web`, com filtro, ordenação e comparação de 2 a 4 projetos; coube no ADR 0002, sem ADR novo). Detalhes em [`e4-implementacao.md`](e4-implementacao.md).
   **E5, [#34](https://github.com/romulospl/stellytics/issues/34) (14/11/2026):** consolidação 1m → 1h → 1d e retenção (35 dias no granular, 25 meses nos consolidados) em funções SQL da migração `0005_api_metric_rollup.sql`, agendadas a cada 15 minutos pelo serviço `services/rollup` (no Compose local). Estimativa de volume para 1 milhão de requisições por dia no spec do E5, seção 5. **Falta:** entrar no `prod.yaml` junto com o coletor, que ainda não está na produção.
   **E5, [#35](https://github.com/romulospl/stellytics/issues/35) (14/11/2026):** backend de exemplo `examples/api-backend` (Node com OTel, histograma `http.server.request.duration` em delta) e guia de dual-export pelo SDK e pelo OTel Collector no README dele. Roda no Compose pelo override `infra/compose/api-example.yaml` (app mais o Collector do tenant, com o exporter `debug` no lugar do APM próprio); o `compose-check.sh` confere as linhas em `api_metric_1m` no job `compose` do CI.

   **E5, [#36](https://github.com/romulospl/stellytics/issues/36) (14/11/2026):** ponta a ponta do pipeline de API no `compose-check.sh` (job `compose`): rota normalizada, status, latência (buckets somam a contagem) e tenant em `api_metric_1m`; trace e log mandados direto ao coletor alegando outro tenant ficam no tenant da chave, e o marcador não aparece em nenhuma coluna de texto do banco `stellytics`.
   **E6, [#37](https://github.com/romulospl/stellytics/issues/37) (14/11/2026):** painel de API do tenant em `/services/[serviceId]`: requisições, erros 5xx, latência p50 e p95, gráficos por balde e tabela por endpoint, lendo 1d, 1h e 1m sem sobreposição. **E6, [#38](https://github.com/romulospl/stellytics/issues/38) (14/11/2026):** painel de API global do SCF em `/operator/api`, uma linha por projeto ativo com requisições, 5xx, 4xx, p50 e p95, filtro, ordenação e período, com os mesmos números do painel de cada serviço. **Com isso, o E6 está completo.** Detalhes em [`e6-implementacao.md`](e6-implementacao.md).
   **E7, [#39](https://github.com/romulospl/stellytics/issues/39) (15/11/2026):** [`arquitetura.md`](arquitetura.md), com o diagrama geral e os fluxos web e API em Mermaid (validados com o mermaid-cli) e a explicação da stack em linguagem simples. Mostra o coletor e o rollup como ainda fora da produção.
   **E7, [#40](https://github.com/romulospl/stellytics/issues/40) (15/11/2026):** [`privacidade.md`](privacidade.md), lido a partir do código: o que é coletado, truncamento de IP, residência na Alemanha (ADR 0004), retenção e as lacunas. Papéis (controlador e operador) e jurisdições ficam como proposta a validar com assessoria jurídica, sem conclusão legal. Achados: o `user_agent` da sessão do portal é gravado (o IP não); os eventos web no Umami não têm retenção configurada; o `audit_log` é permanente; o apagamento da conta e o apagamento dos dados de um projeto removido não existem.
   **E7, [#41](https://github.com/romulospl/stellytics/issues/41) (15/11/2026):** [`anti-bot-e-cadeia-de-suprimentos.md`](anti-bot-e-cadeia-de-suprimentos.md), lido a partir do código: camadas anti-bot com os limites padrão e o que não impedem (bots que executam JS, reuso do token dentro do `PROOF_TTL`, botnets, CORS aberto sem conferir `Origin`) e a cadeia de suprimentos (script imutável com SRI, lockfiles, 14 dias, Renovate, actions por SHA, digests, SBOM, cosign e deploy que verifica a assinatura). Achados: não há varredura de vulnerabilidades nem verificação de licenças no CI, nem build reproduzível verificado; o coletor e o rollup ainda não passam pelo `cosign verify` do Ansible. **Segue pendente, fora do código:** instalar o app do Renovate.
   **E7, [#42](https://github.com/romulospl/stellytics/issues/42) e [#43](https://github.com/romulospl/stellytics/issues/43) (15/11/2026):** [`deploy.md`](deploy.md) revisado como um leitor externo (portas, segredos, ordem dos passos, verificação pós-deploy, troca de segredo e restauração) e [`onboarding-de-tenant.md`](onboarding-de-tenant.md) para web e API (PRs #109 e #108). Validado sem credenciais: `compose config`, `tofu validate` e `ansible --syntax-check`. **Seguem abertas:** a #42 até alguém de fora seguir o guia numa conta real, e a #43 até um piloto real usá-lo (#45 e #46). A coluna "Last used" das chaves de ingestão passou a ser gravada (PR #126, ver abaixo), e o guia já não avisa do contrário. As issues de varredura de vulnerabilidades e licenças e de builds reproduzíveis (lacunas do documento da #41) ainda precisam ser abertas.
   **E9, [#53](https://github.com/romulospl/stellytics/issues/53) (15/11/2026):** runbooks em [`runbooks/`](runbooks/README.md) (PR #111). A revisão achou dois erros que levariam a um incidente pior: rotacionar a chave SSH pelo OpenTofu não revoga a antiga (`ignore_changes` em `ssh_keys`) e a `walg_libsodium_key` não pode ser trocada. Ambos corrigidos. Nenhum runbook foi exercitado numa produção real.
   **E10, [#64](https://github.com/romulospl/stellytics/issues/64) e [#65](https://github.com/romulospl/stellytics/issues/65) (15/11/2026):** rascunhos da proposta e do interest form em [`proposta/`](proposta/proposal.md) (PR #112), com o RFP `scf-web-api-analytics` conferido no Raven (SLAs de 99,99% e 99,90%, 24 h para vulnerabilidades, 12 meses de hospedagem, pilotos de 3 web e 1 API). **Seguem abertas** porque o envio é humano. Do Romulo: código de indicação, orçamento, time, pilotos e cartas, idioma da documentação, favorecido legal. **Ação de conta:** ligar o relato privado de vulnerabilidades (Settings > Code security): o repositório é público e a opção está desligada, mas o `SECURITY.md` manda clicar nela. A divisão 10/20/30/40 não foi confirmada para o RFP Track.
   **E9, [#48](https://github.com/romulospl/stellytics/issues/48) (15/11/2026):** chaves de leitura do SCF e API `/api/v1` (PR #113, [ADR 0006](adr/0006-api-de-leitura-do-scf.md)). Testado com Postgres 17 (201 testes do portal, `go test -race`) e CI completo verde na `main` (`compose`, `go`, `typescript`). Não verificado: `/api/v1/web` contra um Umami real e `/operator/keys` num navegador. O limite por IP é em memória, por instância, e não contém ataque distribuído. **Defeito antigo achado de passagem, já corrigido no PR #125:** `test/api-metrics.test.ts` falhava numa segunda execução contra o mesmo banco, porque o teste deixava uma partição futura que mudava o resultado da execução seguinte (só o teste mudou; as funções da migração estavam certas).
   **E9, [#49](https://github.com/romulospl/stellytics/issues/49) (15/11/2026):** cadastro com aprovação prévia opcional ([ADR 0007](adr/0007-cadastro-com-aprovacao.md)). `SIGNUP_APPROVAL` (e `signup_approval` no Ansible) faz o projeto novo nascer `pending`, com tela de espera e sem painéis, sites, serviços nem chaves; a ingestão já o recusava pelas visões. O operador aprova ou rejeita em `/operator/approvals`, com `audit_log`. Sem migração (o estado já existia) e sem e-mail de notificação. Testado com Postgres 17 (213 testes do portal, lint, typecheck e build). Não verificado: as telas num navegador, o Ansible e o `prod.yaml` com o modo ligado.

   **E9, [#50](https://github.com/romulospl/stellytics/issues/50) (15/11/2026), parcial:** eventos customizados (script v1.2.0 com `window.stellytics.event`, gateway repassa só `name` e `data` validados, [ADR 0008](adr/0008-eventos-customizados-e-wallets-kit.md)). Confirmado no banco do Umami (nome e propriedades). Depois, o PR #122 trouxe o adaptador **opt-in** `window.stellytics.wallets(kit, KitEventType)` (script v1.3.0, [ADR 0010](adr/0010-adaptador-opt-in-do-wallets-kit.md)): assina só `WALLET_SELECTED` (envia o id genérico da carteira, até 32 caracteres) e `DISCONNECT`, nunca `STATE_UPDATED` (que traz o endereço). **Erro corrigido:** o guia e o ADR 0008 usavam `e.id`, mas o handler do kit recebe `{eventType, payload}` e o id fica em `payload.id`. **Segue pendente, e a issue fica aberta:** a captura sem configuração do tenant (impossível sem monkey patching, e só o tenant alcança os callbacks do kit) e a listagem de eventos no painel web. Não verificado: se `on` do kit é síncrono, outras formas de id e o código-fonte do kit.
   **E9, [#51](https://github.com/romulospl/stellytics/issues/51) (15/11/2026):** teste de carga com ferramenta própria em `services/loadtest/` e relatório em [`relatorios/carga-1m-dia.md`](relatorios/carga-1m-dia.md) (PR #120). Medido numa máquina local, sem Caddy, TLS, imagens nem hardware da Hetzner, então **não prova a produção**. A média de 1 milhão por dia (11,6 por segundo) e picos de 10x passaram sem perda. **Gargalo achado:** o Umami satura perto de 200 page views por segundo e o relay do gateway é síncrono e sem limite de requisições em voo. Texto de issue pronto no relatório, ainda não aberta.
   **E9, [#52](https://github.com/romulospl/stellytics/issues/52) (15/11/2026), parcial:** [ADR 0009](adr/0009-alta-disponibilidade.md) e [`sla.md`](sla.md) (PR #118), com o orçamento de erro (99,99% são 4,32 min por mês) e os pontos únicos de falha. A arquitetura atual **não sustenta 99,99%**. Na IaC só há primitivas de provisionamento, desligadas por padrão: o plano com os padrões é idêntico ao anterior. O PR #123 trouxe a replicação em streaming do Postgres (primário com `pg_hba` restrito ao `stellytics_ingest` e ao `replicator`, standby que recusa subir sobre diretório de primário), a pilha de ingestão para réplicas (`prod-ingest.yaml`), os playbooks `ingest.yml` e `standby.yml` e o runbook de failover **manual** ([`runbooks/failover-do-banco.md`](runbooks/failover-do-banco.md)); tudo desligado por padrão, com `prod.yaml` e OpenTofu sem diff. Testado em Docker local (50.000 linhas idênticas, promoção em 164 ms, ex-primário volta como standby), job `infra` do CI roda o teste. RPO (segundos) e RTO (30 a 90 min) são estimativas. O PR #127 trouxe o `SITE_STALE_TTL` do gateway (padrão `0`, desligado, máximo 1 h): com o banco fora, ele serve a última resposta de um site **aceito** por até esse tempo, circuit breaker de 2 s, mapas separados para aceitos e negativos, e site nunca visto, desconhecido ou recusado volta a 503 depois do TTL. **Custo:** um tenant removido durante a queda segue aceitando eventos até `SITE_CACHE_TTL` + `SITE_STALE_TTL`. Ligar exige editar `prod.yaml` e `prod-ingest.yaml`, que ainda não repassam a variável. **Falta:** IP flutuante e balanceador, TLS das réplicas atrás de balanceador, alertas de atraso de replicação e de WAL retido, e um ensaio numa conta real. O failover continua manual e **não sustenta 99,99%**. **Decisão do Romulo:** o `SECURITY.md` promete 14 dias para críticas e 30 para altas, e o RFP tem como meta 24 horas.
   **E9, [#54](https://github.com/romulospl/stellytics/issues/54) (15/11/2026), parcial:** [`transferencia.md`](transferencia.md) (PR #119) e scripts `infra/scripts/db-export.sh`, `db-import.sh` e `db-fingerprint.sh`, com teste ponta a ponta em `infra/compose/test/data-migration-test.sh`. A migração de dados foi testada de verdade (lógica e física com WAL-G, 27 tabelas por banco idênticas). **Não testado:** transferência real de repositório, domínio e contas, restauração contra o Object Storage real, volumes grandes e reversão. O teste não roda no CI (leva minutos e precisa da imagem do portal). A issue só fecha quando o novo operador roda sozinho.
   **Varredura de dependências e limite de repasses (15/11/2026):** o workflow [`dependencies.yml`](../.github/workflows/dependencies.yml) (PR #129, fora do agregador `ci`) roda `govulncheck`, `pnpm audit` e a conferência de licenças contra uma allowlist OSI em `scripts/licenses/allowed.json`. **Achou coisas reais:** duas vulnerabilidades alcançáveis da stdlib do Go 1.26.9 nas imagens de produção (GO-2026-6859, crash do servidor HTTP/1, e GO-2026-6809), corrigidas na go1.26.11, que a regra dos 14 dias libera em 2026-11-16 (o proxy do Go dá 2026-11-02): o job `govulncheck` fica **vermelho de propósito** até os três Dockerfiles subirem para `golang:1.26.11`. Também achou `caniuse-lite` (CC-BY-4.0, que não é OSI, mas não vai para a imagem do portal) e `@img/sharp-libvips` (LGPL-3.0), ambos como **exceções datadas que vencem em 2027-05-15 e dependem da sua aceitação**. O PR #130 trouxe `RELAY_MAX_INFLIGHT` e `RELAY_QUEUE_WAIT` ([ADR 0011](adr/0011-limite-de-repasses-ao-umami.md), desligado por padrão): sem limite a 400 page views/s o gateway chegou a 355 MB e 16.192 respostas 502; com limite a memória ficou entre 31 e 58 MB, ao custo de recusar 50% a 59% com 503. **Decisão sua, pendente:** sob saturação o `503` só sai para site aceito e com fingerprint dentro da cota, o que revela o status do site e a cota (contra a seção 6 do spec do E2); as alternativas estão no ADR 0011 e quem ligar o recurso em produção deve decidir antes.
   **Pendências do lote, agora com issue (15/11/2026):** [#132](https://github.com/romulospl/stellytics/issues/132) subir os Dockerfiles para `golang:1.26.11` (elegível em 2026-11-16); [#133](https://github.com/romulospl/stellytics/issues/133) decidir o `503` sob saturação (decisão sua); [#134](https://github.com/romulospl/stellytics/issues/134) limite por site nos repasses; [#135](https://github.com/romulospl/stellytics/issues/135) alertas de atraso de replicação e WAL retido; [#136](https://github.com/romulospl/stellytics/issues/136) builds reproduzíveis; [#137](https://github.com/romulospl/stellytics/issues/137) repassar as variáveis do gateway nos `prod*.yaml`; [#138](https://github.com/romulospl/stellytics/issues/138) prazo de vulnerabilidades (`SECURITY.md` 14/30 dias contra 24 h do RFP, decisão sua); [#139](https://github.com/romulospl/stellytics/issues/139) exceções de licença CC-BY-4.0 e LGPL-3.0 (decisão sua); [#140](https://github.com/romulospl/stellytics/issues/140) ligar o relato privado de vulnerabilidades e instalar o Renovate (ação de conta). Já resolvidos: varredura de vulnerabilidades e licenças (PR #129), limite de repasses (PR #130), `last_used_on` gravado (PR #126) e o teste `api-metrics` instável (PR #125).
   **Coletor e rollup na produção (16/11/2026):** os dois entraram no `prod.yaml`, sem porta publicada; o OTLP (HTTP e gRPC) sai pelo Caddy num terceiro host, `api_host`, na 443 ([ADR 0012](adr/0012-ingestao-de-api-pelo-caddy.md)). O Ansible confere as quatro imagens com cosign, o coletor tem teto de memória (`collector_mem_limit`) e o monitoramento testa o host com um POST sem chave (módulo `otlp_401`). O `rollup` passou a tentar de novo em 30 s depois de uma execução com falha (antes ficava um intervalo inteiro parado e `unhealthy`). Testado em Docker local: `prod-stack-test.sh` (401 sem chave em HTTP e gRPC, 404 no resto, métrica gravada no tenant da chave, backup e restauração), `monitoring-test.sh`, `ansible-lint` e `caddy validate`. **Não testado:** o módulo `otlp_401` contra um coletor de verdade, `ha-replication-test.sh` e `data-migration-test.sh` depois da mudança (só receberam as variáveis novas), e qualquer conta real. **Falta:** um terceiro registro de DNS no deploy, limite por chave no coletor e réplica do coletor.
   **E7, [#139](https://github.com/romulospl/stellytics/issues/139) (17/11/2026):** decisão sobre as duas exceções de licença. **`caniuse-lite` (CC-BY-4.0): aceita**, com a justificativa reescrita e a atribuição registrada em [`avisos-de-terceiros.md`](avisos-de-terceiros.md) — é uma exceção de build (next/browserslist), não vai para o standalone do portal, e essa ausência passa a ser conferida pelo teste da pilha. **`@img/sharp-libvips-*` (LGPL-3.0-or-later): não distribuída** — a exceção segue registrada como dependência temporária de build, mas a decisão foi desligar o otimizador de imagens do portal (`images.unoptimized`), responder `404` em `/_next/image` no proxy e remover sharp/libvips do standalone no Dockerfile antes da imagem final; se um dia a LGPL for distribuída, exige nova decisão e cumprimento das obrigações. `CONTRIBUTING.md` atualizado com as duas regras (exceções temporárias para dependências de build e a janela restrita para releases novas em correção de vulnerabilidade crítica/alta). Testado com a suíte dos conferidores de licença e o `prod-stack-test.sh` (404 no otimizador e ausência de sharp/libvips/caniuse-lite na imagem). O review do PR acrescentou uma rede estrutural: como o libvips é o único módulo nativo esperado, a remoção no Dockerfile e o teste da imagem recusam também qualquer binário `*.node`, e o teste distingue o 404 de corpo vazio da guarda do proxy do 404 em HTML do próprio Next. **Pendências sem issue, do review (17/11/2026):** a redação "no máximo seis meses, 183 dias" em `CONTRIBUTING.md` pode contradizer a checagem (seis meses corridos podem ter 184 dias; o conferidor aplica só os 183); o SQL de contas de desenvolvimento (`drizzle-dev/`, senhas conhecidas, incluindo operador) segue no `COPY` da imagem de produção, travado por convenção (`SEED_DEV_DATA` nunca setado no prod); não há teste unitário da regra 404 do `proxy.ts` (coberto pelo teste de pilha).
   **E7, [#154](https://github.com/romulospl/stellytics/issues/154) (17/11/2026):** direito ao apagamento, em três fluxos. **Exclusão da própria conta** em `/settings` (`src/app/(private)/settings/`), com confirmação pelo e-mail digitado: apaga os sites do projeto no Umami, as linhas de site/serviço/chave, as métricas de API (`api_metric_purge_tenant`, nova migração `0009_erasure.sql`), as chaves de leitura do SCF do usuário e a linha do usuário (sessão e senha em cascata); o projeto fica `removed`, sem dados. **Audit_log:** a única mudança que os gatilhos aceitam é trocar `actor_user_id` pelo marcador `[apagado]`, na exclusão da conta — as ações ficam no histórico, anonimizadas. **Apagamento de projeto removido** pelo operador em `/operator/tenants/[id]`, com confirmação por slug digitado. **Retenção dos eventos do Umami:** o `services/rollup` ganhou `UMAMI_DATABASE_URL` e `UMAMI_RETENTION_DAYS` (padrão 183, cerca de seis meses) e apaga `website_event` e `session` antigos, preservando a sessão que ainda sustenta eventos recentes — o Umami 3.4.1 não tem retenção própria. **Declarações públicas** no README (residência na UE, jurisdições, fluxo de apagamento) e `privacidade.md` reescrito (seções 1, 3.4, 6, 7, 8 e 9); o `session_id` foi analisado no código-fonte da v3.4.1: `uuid5(sha512(website_id, ip truncado, user_agent, sal mensal, distinct_id, APP_SECRET))`. Testado com a suíte de isolamento (novos casos de apagamento e do gatilho), `go test` do rollup (config e `TestPruneUmami`) e typecheck. **Não testado:** as telas em navegador real e o `prod.yaml` com a retenção ligada. **Seguem sem fluxo:** pedidos individuais de titulares (retificação, portabilidade, um visitante específico) — procedimento manual documentado em `privacidade.md`.
   **E7, [#153](https://github.com/romulospl/stellytics/issues/153) (19/11/2026):** pendências do review do PR #151. `CONTRIBUTING.md` passa a dizer "no máximo 183 dias, cerca de seis meses", igual ao conferidor. O `drizzle-dev` saiu da imagem de produção: o Dockerfile do portal ganhou o estágio `dev`, usado só pelo `infra/compose/dev.yaml` (`target: dev`), e o último estágio (alvo padrão do `release.yml` e do `prod-vps.yaml`) não o leva; `test/dockerfile.test.ts` confere isso e que nenhum `prod*.yaml` nem o `env.j2` do Ansible define `SEED_DEV_DATA`. A regra 404 de `/_next/image` (barra final, percent-encoding) ganhou teste unitário em `test/proxy.test.ts`.
 4. **Pode ser feita a qualquer momento:** a [#32 (5.3)](https://github.com/romulospl/stellytics/issues/32), normalização de rotas, que não depende de nada.
5. **Fora do código, sem dependência:**
   - buscar o código de indicação e enviar o Interest form ([#64](https://github.com/romulospl/stellytics/issues/64));
   - captar 3 ou 4 projetos financiados pelo SCF como pilotos e pedir cartas de interesse ([#44](https://github.com/romulospl/stellytics/issues/44)).
6. **Decisões em aberto sobre o quadro:**
   - criar uma label `poc` para marcar, dentro do Ready, o que precisa existir antes da submissão;
   - criar 4 milestones, uma por parcela (10/20/30/40%), depois que a #65 definir os marcos;
   - mover #44 (pilotos) para Ready, porque não depende de código (a #39 já foi feita);
   - tirar os épicos da coluna Ready ou filtrá-los da visão;
7. **Idioma:** decidir se a documentação do repositório passa para inglês antes da submissão. Os revisores do SCF leem em inglês, e isso pesa na avaliação da documentação e na transferência para outra equipe.
8. **Concluído:** o ADR 0003 registra que o isolamento é do portal, e o spec do E2 fixa o contrato. A pendência do ADR 0001 sobre a chave de API do Umami foi resolvida na #58: a chave de um usuário comum do Umami basta, sem a senha de administrador.
9. **Lacunas sem issue, apontadas pelo spec do E2:**
   - convite de membros para um tenant (hoje só quem cria o projeto tem acesso);
   - fluxo de pedidos de titulares: a exclusão de conta e o apagamento de projeto existem ([#154](https://github.com/romulospl/notify/issues/154)), mas não há processo documentado para retificação, portabilidade ou um pedido individual de visitante — o procedimento manual está em [`privacidade.md`](privacidade.md), seção 7, e ainda precisa de issue própria.
10. **Specs seguintes:** o do E3 ao começar a #61 e o do E5 ao começar a #30 ou a #33.
