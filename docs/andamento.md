# Andamento do projeto

Registro do que já foi feito, das decisões tomadas e dos próximos passos. Atualizado em **14/11/2026**.

## Resumo

| Item | Situação |
|---|---|
| Escopo do MVP | Definido a partir do RFP (seção [MVP](#1-mvp-definido-a-partir-do-rfp)) |
| Backlog | 10 épicos e 55 issues no GitHub (#1–#65), revisado em 13/11/2026 |
| Quadro do projeto | 16 itens em Done, 3 em In progress, 27 em Ready e 19 em Backlog |
| Ferramenta base | **Umami v3.4.1** ([ADR 0001](adr/0001-ferramenta-base.md)) |
| Arquitetura e stack | Definidas ([ADR 0002](adr/0002-arquitetura-e-stack.md)) |
| Repositório | Estrutura do monorepo (#11), ambiente local com Docker Compose (#12), CI (#13), Renovate e releases assinadas (#55) |
| Código | Portal com o E2 feito até onde dá sem o coletor: a #20 e a #21 só esperam a parte do coletor (#30). No E4, painéis web do tenant (#28) e do SCF (#29), detalhados em [`e4-implementacao.md`](e4-implementacao.md), detalhado em [`e2-implementacao.md`](e2-implementacao.md). No E3, script de rastreamento (#22) e gateway de ingestão (#61) |

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

Repositório: [romulospl/notify](https://github.com/romulospl/notify/issues).

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
| [#1 E1](https://github.com/romulospl/notify/issues/1) | #10–#15, #55, #56 | Fundação do monorepo e infraestrutura |
| [#2 E2](https://github.com/romulospl/notify/issues/2) | #16–#21, #57–#60 | Multi-tenant, cadastro e controle de acesso |
| [#3 E3](https://github.com/romulospl/notify/issues/3) | #22–#27, #61, #62 | Coleta de analytics web |
| [#4 E4](https://github.com/romulospl/notify/issues/4) | #28–#29 | Painéis de analytics web |
| [#5 E5](https://github.com/romulospl/notify/issues/5) | #30–#36 | Pipeline de analytics de API (OpenTelemetry) |
| [#6 E6](https://github.com/romulospl/notify/issues/6) | #37–#38 | Painéis de analytics de API |
| [#7 E7](https://github.com/romulospl/notify/issues/7) | #39–#43 | Documentação, privacidade e conformidade |
| [#8 E8](https://github.com/romulospl/notify/issues/8) | #44–#47 | Pilotos e prova de adoção |
| [#9 E9](https://github.com/romulospl/notify/issues/9) | #48–#54 | Pós-MVP |
| [#63 E10](https://github.com/romulospl/notify/issues/63) | #64, #65 | Proposta e submissão ao SCF |

### Revisão de 13/11/2026

O backlog foi comparado com o RFP e com o ADR 0002. A cobertura do RFP estava completa, mas faltavam issues para peças centrais e várias issues eram anteriores ao ADR 0002.

- **Issues criadas:**
  - portal: [#57](https://github.com/romulospl/notify/issues/57) (esqueleto e login), [#58](https://github.com/romulospl/notify/issues/58) (conta de serviço no Umami), [#59](https://github.com/romulospl/notify/issues/59) (chaves de ingestão) e [#60](https://github.com/romulospl/notify/issues/60) (verificação de e-mail);
  - gateway: [#61](https://github.com/romulospl/notify/issues/61) (o serviço) e [#62](https://github.com/romulospl/notify/issues/62) (Umami só na rede interna, gravação de sessão e heatmaps desligados);
  - fundação: [#55](https://github.com/romulospl/notify/issues/55) (cadeia de suprimentos aplicada) e [#56](https://github.com/romulospl/notify/issues/56) (`SECURITY.md`, `CONTRIBUTING.md` e modelos de issue);
  - proposta: épico [#63](https://github.com/romulospl/notify/issues/63), com [#64](https://github.com/romulospl/notify/issues/64) (Interest form e código de indicação) e [#65](https://github.com/romulospl/notify/issues/65) (redigir a proposta).
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
- **Backlog (19):** os épicos E7, E8 e E9 e as issues #39–#54 (documentação, pilotos e pós-MVP).

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
  - bancos `umami` e `notify`;
  - particionamento nativo por mês e rollups de 1 min para 1 h e 1 dia;
  - sem TimescaleDB, por causa da licença TSL.
- **Infra:** Terraform, Ansible, Docker Compose e Caddy, com hospedagem na União Europeia.

### Isolamento no portal ([ADR 0003](adr/0003-isolamento-no-portal.md)) e spec do E2

O portal lê o Umami com uma conta de serviço que enxerga tudo, então o isolamento entre tenants é responsabilidade só do portal. O contrato está no [spec do E2](specs/e2-tenants-e-controle-de-acesso.md), aceito em 13/11/2026 com seis decisões:

- **D1:** um usuário pertence a um único tenant.
- **D2:** operador SCF não é membro de tenant.
- **D3:** não há papel de administrador; operador é criado por script.
- **D4:** um usuário de banco por serviço (`notify`, `notify_ingest`, `notify_collector`).
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
| `infra/compose/postgres/init/02-ingest-roles.sh` | Usuários `notify_ingest` e `notify_collector` do banco (#16) |
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

## 6. Pendências e próximos passos

1. **Concluída:** a [#11 (1.2)](https://github.com/romulospl/notify/issues/11), com `LICENSE` (MIT), esqueleto de pastas, pnpm workspaces, Turborepo e `services/go.mod`. Cada pasta tem um `README.md` com o papel dela e a issue que a cria.
2. **Concluída:** a [#12 (1.3)](https://github.com/romulospl/notify/issues/12), com Postgres 17.11 e Umami 3.4.1 fixados por digest. 
   **Concluída:** a [#13 (1.4)](https://github.com/romulospl/notify/issues/13), com CI no GitHub Actions (actions fixadas por SHA, Postgres nos testes e o Compose testado a cada PR). Por decisão de 13/11/2026, a `main` fica **sem proteção de branch**: o CI roda, mas não bloqueia merge nem push direto. Se a proteção for ligada, basta exigir o check `ci`.
   **Concluída:** a [#56 (1.8)](https://github.com/romulospl/notify/issues/56), com `SECURITY.md`, `CONTRIBUTING.md` e modelos de issue (bug, dúvida de tenant, pedido de recurso). **Pendência:** o relato privado de vulnerabilidades do GitHub só existe em repositório público; ao abrir o repositório, ligar em *Settings → Code security → Private vulnerability reporting*.
   **Concluída:** a [#55 (1.7)](https://github.com/romulospl/notify/issues/55), com Renovate (14 dias de espera) e o workflow de release com SBOM, imagens no GHCR assinadas com cosign e o comando de verificação no README. **Pendência:** instalar o app do Renovate no repositório (github.com/apps/renovate), que é uma ação da conta; sem ele o `renovate.json` não tem efeito.
3. **Concluída:** a [#57 (2.7)](https://github.com/romulospl/notify/issues/57), esqueleto do portal com login (Better Auth + Drizzle), rotas privadas, imagem Docker e portal no Compose.
   **E2 completo até onde dá sem o coletor:** concluídas a #16, #58, #18, #59, #60, #17 e #19 em 13/11/2026. Em 14/11/2026 entraram a parte do portal da [#20](https://github.com/romulospl/notify/issues/20) (remover e reativar projeto, com histórico no `audit_log`; o gateway web já descarta os eventos do projeto removido) e a [#21](https://github.com/romulospl/notify/issues/21) (suíte de isolamento em `apps/portal/test/isolation.test.ts`). As duas ficam abertas só pelo que depende do coletor ([#30](https://github.com/romulospl/notify/issues/30), E5): recusar a métrica de API de projeto removido e trocar os três `it.todo` da suíte por testes contra o coletor. Detalhes em [`e2-implementacao.md`](e2-implementacao.md).
   **E3:** concluídas a [#22](https://github.com/romulospl/notify/issues/22) (script de rastreamento) e a [#61](https://github.com/romulospl/notify/issues/61) (gateway de ingestão web), pelos PRs #74 e #75.
   **E4:** em 14/11/2026, a [#28](https://github.com/romulospl/notify/issues/28) (painel web do tenant com as 7 métricas, em `/sites/[siteId]`, que também confirmou a pendência do ADR 0001 sobre as métricas do Umami) e a [#29](https://github.com/romulospl/notify/issues/29) (painel web global do SCF em `/operator/web`, com filtro, ordenação e comparação de 2 a 4 projetos; coube no ADR 0002, sem ADR novo). Detalhes em [`e4-implementacao.md`](e4-implementacao.md).
4. **Pode ser feita a qualquer momento:** a [#32 (5.3)](https://github.com/romulospl/notify/issues/32), normalização de rotas, que não depende de nada.
5. **Fora do código, sem dependência:**
   - buscar o código de indicação e enviar o Interest form ([#64](https://github.com/romulospl/notify/issues/64));
   - captar 3 ou 4 projetos financiados pelo SCF como pilotos e pedir cartas de interesse ([#44](https://github.com/romulospl/notify/issues/44)).
6. **Decisões em aberto sobre o quadro:**
   - criar uma label `poc` para marcar, dentro do Ready, o que precisa existir antes da submissão;
   - criar 4 milestones, uma por parcela (10/20/30/40%), depois que a #65 definir os marcos;
   - mover #39 (diagrama) e #44 (pilotos) para Ready, porque não dependem de código;
   - tirar os épicos da coluna Ready ou filtrá-los da visão;
   - dividir a #50 em eventos customizados (o Umami já suporta) e captura do Wallets Kit.
7. **Idioma:** decidir se a documentação do repositório passa para inglês antes da submissão. Os revisores do SCF leem em inglês, e isso pesa na avaliação da documentação e na transferência para outra equipe.
8. **Concluído:** o ADR 0003 registra que o isolamento é do portal, e o spec do E2 fixa o contrato. A pendência do ADR 0001 sobre a chave de API do Umami foi resolvida na #58: a chave de um usuário comum do Umami basta, sem a senha de administrador.
9. **Lacunas sem issue, apontadas pelo spec do E2:**
   - convite de membros para um tenant (hoje só quem cria o projeto tem acesso);
   - exclusão da própria conta pelo usuário, que o documento de privacidade (#40) precisa prever.
10. **Specs seguintes:** o do E3 ao começar a #61 e o do E5 ao começar a #30 ou a #33.
