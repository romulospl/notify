# E2: o que foi implementado

Registro da implementação do épico [E2 (#2)](https://github.com/romulospl/notify/issues/2), multi-tenant, cadastro e controle de acesso, feita em **13/11/2026**. O contrato que estas issues seguem está no [spec do E2](specs/e2-tenants-e-controle-de-acesso.md) e no [ADR 0003](adr/0003-isolamento-no-portal.md). Aqui fica o que foi construído, onde está, as escolhas feitas na implementação e o que falta.

## 1. Situação

As 9 issues de código do E2 estão na `main` (a #57, esqueleto do portal, já existia antes). Oito estão fechadas; a #21 continua aberta só pelo caso que depende do exporter do coletor (#31, E5). Cada PR foi mergeado por rebase com o CI verde, então cada issue tem o próprio commit.

| Issue | O que é | PR | Commit |
|---|---|---|---|
| [#16 (2.1)](https://github.com/romulospl/notify/issues/16) | Modelo de tenant, visões e usuários de ingestão | [#71](https://github.com/romulospl/notify/pull/71) | `4eb25c3` |
| [#58 (2.8)](https://github.com/romulospl/notify/issues/58) | Conta de serviço e provisionamento no Umami | [#71](https://github.com/romulospl/notify/pull/71) | `4c3da83` |
| [#18 (2.3)](https://github.com/romulospl/notify/issues/18) | Camada única de acesso a dados | [#72](https://github.com/romulospl/notify/pull/72) | `2f8a2d1` |
| [#59 (2.9)](https://github.com/romulospl/notify/issues/59) | Serviços de API e chaves de ingestão | [#73](https://github.com/romulospl/notify/pull/73) | `9d33fdf` |
| [#60 (2.10)](https://github.com/romulospl/notify/issues/60) | Confirmação de e-mail e recuperação de senha | [#76](https://github.com/romulospl/notify/pull/76) | `e037b11` |
| — | Correção da #59: nome de serviço repetido em pedidos simultâneos | [#76](https://github.com/romulospl/notify/pull/76) | `a6534fa` |
| [#17 (2.2)](https://github.com/romulospl/notify/issues/17) | Cadastro self-service do projeto | [#77](https://github.com/romulospl/notify/pull/77) | `6f0a1cf` |
| [#19 (2.4)](https://github.com/romulospl/notify/issues/19) | Operador SCF, comando de administração e seed | [#78](https://github.com/romulospl/notify/pull/78) | `b262905` |
| [#20 (2.5)](https://github.com/romulospl/notify/issues/20) | Remoção e reativação de projeto (o coletor, #30, recusa a chave do projeto removido; teste da transição na branch `test/e2-collector-isolation`) | [#88](https://github.com/romulospl/notify/pull/88) | `f83dc69` |
| — | Correção da #59: ações de chave com ID de outro tenant respondem 404 | [#88](https://github.com/romulospl/notify/pull/88) | `de177f7` |
| [#21 (2.6)](https://github.com/romulospl/notify/issues/21) | Suíte de isolamento (falta o caso do exporter, #31) | [#88](https://github.com/romulospl/notify/pull/88) | `f867a3d` |

O spec do E2 e o ADR 0003 entraram junto, no commit `75658a7`.

## 2. O que já funciona

**Para um projeto Stellar (tenant):**

1. `/sign-up`: cria a conta. Chega um e-mail com o link de confirmação.
2. O link confirma o e-mail, abre a sessão e leva a `/onboarding`.
3. `/onboarding`: dá nome ao projeto e vira dono dele.
4. `/sites`: cadastra os sites web. Cada um é criado no Umami, e a tela mostra o ID do site.
5. `/services`: cadastra os serviços de API. Cada um sai com a primeira chave de ingestão, mostrada uma vez só. Em `/services/[serviceId]`, cria e revoga chaves.
6. `/forgot-password`: recupera a senha por um link de 30 minutos.

**Para o operador SCF:**

- `/operator` lista todos os projetos, inclusive removidos, com contagens de membros, sites, serviços e chaves ativas.
- `/operator/tenants/[tenantId]` mostra membros, sites e serviços de um projeto. Das chaves, só o prefixo e as datas.
- Na mesma tela, remove o projeto (com motivo obrigatório) ou o reativa, e vê o histórico de status: quem, quando e por quê (#20).
- Operador só nasce pelo comando de administração (`pnpm operator:create`).

**Ainda não existem:** os painéis com métricas web (E4) e de API (E6), e a recusa da ingestão de API de projeto removido, que depende do coletor (#30).

## 3. O que cada issue entregou

### #16: modelo de tenant

- **Tabelas** em `apps/portal/src/lib/db/schema.ts`, migração `drizzle/0001_tenant_model.sql`: `tenant`, `tenant_member`, `site`, `api_service`, `ingest_key` e `audit_log`, conforme a seção 3 do spec.
- **Regras no banco, além do spec:**
  - chave estrangeira composta: `ingest_key.tenant_id` é sempre o tenant do serviço da chave;
  - o banco confere o formato do prefixo da chave (8 caracteres base32) e o tamanho do hash (32 bytes);
  - `audit_log` só aceita inserção: um gatilho recusa `UPDATE`, `DELETE` e `TRUNCATE`.
- **Visões e usuários de ingestão (D4)**, migração `drizzle/0002_ingest_views.sql`, escrita à mão:
  - `ingest_site` (para o gateway web): o ID do site no Umami e se ele aceita ingestão agora;
  - `ingest_key_active` (para o coletor): só chaves não revogadas, de serviço não arquivado e tenant ativo;
  - `notify_ingest` e `notify_collector` leem só a própria visão, nenhuma tabela.
- **Os dois usuários do banco são criados fora das migrações**, porque isso exige superusuário: `infra/compose/postgres/init/02-ingest-roles.sh`. A migração para com uma mensagem clara se eles não existirem. O CI roda o mesmo script antes dos testes.
- O usuário `notify` pode assumir esses dois papéis (`SET ROLE`, sem herdar nada), só para os testes de permissão.

### #58: Umami

- **Pendência do ADR 0001 resolvida:** a chave de API do Umami 3.4.1 basta para a conta de serviço, sem a senha de administrador. Conferido no código do Umami e no Umami local, e registrado no ADR 0001.
  - A conta de serviço é um usuário **comum** do Umami (`notify-portal`, papel `user`). Ela cria, lista, lê e apaga os próprios sites, e as rotas de usuários e de administração recusam a chave.
  - **Limite:** a chave também consegue criar equipes no Umami. O portal não usa essa rota (ADR 0003).
- **Script** `pnpm umami:service-account`: usa a senha de administrador uma vez, cria (ou atualiza) o usuário de serviço com uma senha aleatória que ninguém guarda, e imprime uma chave nova. Com `--revoke-old`, apaga as chaves anteriores.
- **Cliente único** em `src/lib/umami/`:
  - `createSite` cria o site no Umami e depois grava a linha em `site`; se a gravação falhar, apaga o site no Umami;
  - `getSiteStats` só aceita o ID do site do portal e confere que é do tenant antes de chamar o Umami;
  - `findUmamiInconsistencies` aponta sites que sumiram do Umami e sites do Umami sem vínculo.
- O job `compose` do CI testa a conta de serviço contra o Umami de verdade a cada PR.

### #18: camada única de acesso a dados

- **Contextos** em `src/lib/access.ts`, com tipos marcados (só esse arquivo consegue criá-los, sempre a partir da sessão):
  - `requireTenantContext()` / `getTenantContext()` para membros de tenant;
  - `requireOperatorContext()` para operadores;
  - `requireOnboardingContext()` para quem ainda vai criar o projeto (veio na #17).
- **Regra de lint** (`eslint.config.mjs`):
  - só `src/lib/data/` importa o cliente do banco e o driver `postgres`;
  - só `src/lib/umami/` chama o Umami;
  - o esquema (`db/schema`) pode ser importado em qualquer lugar.
  - `test/lint-boundaries.test.ts` roda o ESLint sobre imports de exemplo, para a regra não quebrar sem aviso.
- **Recurso de outro tenant responde 404**: a função de `lib/data/` devolve nulo e a página chama `notFound()`. As rotas do tenant não levam o ID do tenant na URL; só as de `/operator` aceitam `tenantId`.

### #59: chaves de ingestão

- **Formato** em `src/lib/ingest-key.ts` (contrato com o coletor): `ntf_<prefixo>_<segredo>`, com prefixo de 8 caracteres e segredo de 256 bits. O banco guarda só o prefixo e o SHA-256 da chave completa.
- **Funções** em `src/lib/data/api-services.ts`:
  - criar serviço já gera a primeira chave;
  - até 5 chaves ativas por serviço, garantido com trava na linha do serviço (vale com pedidos simultâneos);
  - criar e revogar entram no `audit_log` só com o prefixo;
  - projeto removido não cria serviço nem chave, mas ainda pode revogar.
- A chave completa aparece uma vez, na resposta da criação, e nunca vai para log. Há um teste que confere isso.
- **Correção posterior** (`a6534fa`): o Drizzle embrulha o erro do Postgres em `cause`, então dois cadastros simultâneos com o mesmo nome davam erro genérico. O teste de corrida falhava só às vezes; depois da correção, passou em 15 rodadas seguidas.

### #60: confirmação de e-mail e recuperação de senha

- **Configuração do Better Auth** em `src/lib/auth.ts`:
  - cadastro aberto, com confirmação de e-mail obrigatória: sem confirmar, a pessoa não entra (e recebe outro link ao tentar);
  - link de confirmação vale 24 horas; o de senha, 30 minutos, uma vez só, e trocar a senha encerra todas as sessões;
  - cadastro com e-mail existente e pedido de senha para e-mail sem conta recebem a mesma resposta dos casos normais, sem revelar quem tem conta;
  - log no nível `warn`, porque o nível `info` registraria o e-mail de quem tenta se cadastrar de novo.
- **Limites por IP** (em memória): entrar, 3 a cada 10 segundos (padrão do Better Auth); cadastrar, 10 por hora; pedir link, 5 por hora.
- **E-mail** em `src/lib/mail.ts`: só texto puro, por SMTP (`SMTP_URL`), com `nodemailer` 10.3.1 (licença MIT-0, aprovada pela OSI). Nem o destinatário nem o link vão para o log.
- **Mailpit v1.32.0** no Compose: caixa de entrada em `http://127.0.0.1:8025` e SMTP em `127.0.0.1:1025`.
- **Telas:** `/sign-up`, `/forgot-password`, `/reset-password` e `/email-verified`.

### #17: cadastro self-service do projeto

- `/onboarding` cria o tenant `active`, o membro `owner` e a entrada `tenant.created` no `audit_log`, numa transação (`src/lib/data/tenants.ts`).
- Só chega lá quem tem e-mail confirmado, não é operador e ainda não tem projeto. Quem já tem vai para o painel.
- Quem não tem projeto e abre uma página do tenant é levado a `/onboarding`.
- Dois pedidos ao mesmo tempo do mesmo usuário criam um projeto só (D1).
- O slug vem do nome; se já existir, ganha um sufixo aleatório.
- `/sites` cadastra sites no Umami, e o painel mostra o nome do projeto e atalhos para sites e serviços.

### #19: operador SCF

- **Comando de administração** `scripts/operator.mjs` (`pnpm operator:create`, `operator:promote` e `operator:demote`): é o único jeito de criar ou promover operador (D3). Cada mudança vai para o `audit_log` e encerra as sessões da conta. O `pnpm user:create` não cria mais operador.
- **D2 no banco** (migração `drizzle/0003_operator_not_member.sql`): um gatilho recusa pôr operador num tenant e promover a operador quem já é membro de um.
- **Visão global** em `src/lib/data/operator/tenants.ts` e nas telas `/operator` e `/operator/tenants/[tenantId]`, só leitura.
- **Seed de desenvolvimento** (`pnpm db:seed`, senha em `SEED_PASSWORD`): 2 projetos de teste (cada um com dono, serviço e chave) e 1 operador. Pode rodar mais de uma vez. Com `UMAMI_API_KEY`, cria também um site no Umami por projeto.

### #20: remoção e reativação de projeto (parte do portal)

- **Funções** `removeTenant` e `reactivateTenant` em `src/lib/data/operator/tenants.ts`, as únicas escritas do operador. Recebem `OperatorContext`, travam a linha do tenant (`SELECT ... FOR UPDATE`) e gravam status, `status_changed_at`, `status_changed_by` e `status_reason`, mais uma linha no `audit_log` (`tenant.removed` ou `tenant.reactivated`, com o status anterior e o motivo).
- **Escolhas:**
  - o motivo da remoção é obrigatório (3 a 500 caracteres), porque o projeto o vê no painel; o da reativação é opcional e fica só no `audit_log` (a coluna `status_reason` volta a nulo);
  - remover o que já está removido, ou reativar o que não está, não grava nada (devolve `"unchanged"`); dois operadores ao mesmo tempo geram um registro só;
  - reativar vale só para `removed`. Um tenant `pending` não é aprovado por aqui: isso fica para o cadastro com aprovação (#49).
- **Telas:** formulário e histórico de status em `/operator/tenants/[tenantId]` (`status-form.tsx`, ações em `actions.ts`). As ações chamam `requireOperatorContext()` antes de tudo, então membro de tenant recebe 404.
- **Ingestão:** nada mudou no gateway nem nas visões. `ingest_site` e `ingest_key_active` (migração 0002) já exigem `tenant.status = 'active'`, então o gateway web passa a descartar os eventos em até 1 minuto (o cache dele). O teste `services/ingest-web/e2e/tenant_status_test.go` confere isso de ponta a ponta, com o Umami de verdade.
- **O que já existia e continua valendo:** o membro de projeto removido ainda entra, vê o aviso com o motivo em `/dashboard` e não cadastra site, serviço nem chave (só revoga chave).
- **Ingestão de API:** o coletor (#30) lê a mesma visão `ingest_key_active`, então recusa com `401` (HTTP) ou `Unauthenticated` (gRPC) a chave de projeto removido, com cache de no máximo 60 segundos. O teste `services/collector/e2e/isolation_test.go` confere a transição: a chave aceita passa a ser recusada depois da remoção e volta a valer depois da reativação.

### #21: testes de isolamento

- **Suíte única** em `apps/portal/test/isolation.test.ts`, com os casos da seção 8 do spec: dois tenants (A e B) com site, serviço e chave, um operador e um usuário sem projeto.
- Os casos passam pelo que o navegador alcança (páginas e server actions, com a sessão simulada, inclusive o `update-user` do Better Auth) e pelo que a ingestão lê (as visões, consultadas como `notify_ingest` e `notify_collector`).
- **A parte do coletor** fica no e2e dele: chave de tenant removido recusada (`services/collector/e2e/e2e_test.go`, da #30) e chave revogada ou tenant removido **depois** de aceitos, recusados em até o cache, com reativação (`isolation_test.go`).
- **Falta um caso**, que segue como `it.todo`: métrica com a chave de A dizendo ser de B é gravada como A. Ele depende do exporter que grava as métricas (#31, PR #97).
- **Conferido que a suíte pega falhas:** tirar o filtro de tenant de `getApiService` faz o caso de URL falhar, e manter o tenant ativo no e2e faz o page view a mais aparecer no Umami.
- Cada painel novo (#28 e #37) acrescenta os próprios casos a esta suíte.
- O helper `test/helpers/as-role.ts` (consulta como outro papel do banco) saiu de `tenant-model.test.ts` para ser usado pelas duas suítes.

## 4. Como rodar localmente

Na raiz do repositório:

```bash
docker compose up -d --wait
```

Sobe Postgres, Umami, Mailpit e o portal (`http://localhost:3000`). Volume do Postgres criado antes da #16 precisa dos usuários de ingestão, sem apagar os dados:

```bash
docker compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh
```

Chave da conta de serviço do Umami (vai em `UMAMI_API_KEY` no `.env` da raiz; depois, `docker compose up -d portal`):

```bash
cd apps/portal
read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
# O Umami só publica a porta com o override de desenvolvimento (#62):
#   docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d
UMAMI_URL=http://127.0.0.1:3001 pnpm umami:service-account
```

Dados de teste:

```bash
cd apps/portal
read -rs SEED_PASSWORD && export SEED_PASSWORD
pnpm db:seed
```

Os e-mails do portal aparecem em `http://127.0.0.1:8025`. Use `127.0.0.1` em vez de `localhost` para o Umami: se outro programa escutar a mesma porta em IPv6, `localhost` cai nele.

Detalhes de cada parte estão no [README do portal](../apps/portal/README.md).

## 5. Testes

107 testes no portal, mais 3 pendentes do coletor (`pnpm test` na raiz ou em `apps/portal`), contra um Postgres real; o Umami é simulado (`test/fake-umami.ts`) e o envio de e-mail também.

| Arquivo | Cobre |
|---|---|
| `tenant-model.test.ts` | Tabelas, restrições, `audit_log` só de inserção e permissões dos usuários de ingestão |
| `umami.test.ts` | Criação de site, desfazer no Umami, leitura de estatísticas e consistência |
| `access.test.ts` | Contextos de tenant e de operador, com sessão simulada |
| `lint-boundaries.test.ts` | Regra de lint da camada única |
| `ingest-keys.test.ts` | Formato, limite com pedidos simultâneos, revogação, `audit_log` e chave fora dos logs |
| `email-flows.test.ts` | Cadastro, confirmação, redefinição de senha e limites de tentativa |
| `onboarding.test.ts` | Quem pode criar projeto, criação, slug e corrida |
| `operator.test.ts` | Gatilho da D2, comando de administração, seed, visão global, remoção e reativação |
| `isolation.test.ts` | Suíte de isolamento da seção 8 do spec (#21) |
| `auth.test.ts` | Login, sessão sem IP e papel nunca vindo do cliente |

O job `compose` do CI, além de subir o ambiente, confere as permissões dos usuários de ingestão, a conta de serviço no Umami, o Mailpit e a tela de cadastro, e roda os testes ponta a ponta do gateway, entre eles o de tenant removido (`services/ingest-web/e2e/tenant_status_test.go`).

## 6. Variáveis de ambiente novas

| Variável | Uso |
|---|---|
| `UMAMI_URL` | Endereço interno do Umami (padrão `http://127.0.0.1:3001`, que só existe com o override `infra/compose/umami-port.yaml`; no Compose, `http://umami:3000`) |
| `UMAMI_API_KEY` | Chave da conta de serviço. Sem ela, o portal sobe, mas não cria sites |
| `SMTP_URL` | Servidor SMTP. Sem ele, o portal sobe, mas os e-mails falham (o erro vai para o log) |
| `MAIL_FROM` | Remetente dos e-mails |
| `NOTIFY_INGEST_DB_PASSWORD`, `NOTIFY_COLLECTOR_DB_PASSWORD` | Senhas dos usuários de ingestão no Compose |
| `MAILPIT_PORT`, `MAILPIT_SMTP_PORT` | Portas locais do Mailpit |

## 7. Limites e pendências

**O que falta no E2 depende do exporter do coletor (#31, E5):**

- **#21:** o caso "métrica com a chave de A dizendo ser de B é gravada como A", hoje um `it.todo`. Quando o exporter gravar as métricas, o teste vai para o e2e do coletor.

**Ficou para outros épicos:**

- `ingest_key.last_used_on` ainda não é atualizado; quem atualiza (o coletor precisaria de permissão de escrita) fica para o spec do E5.
- O `INSERT` do `notify_collector` nas tabelas de métricas entra no E5, junto com as tabelas.
- O SMTP de produção depende da IaC (#14, E1).

**Limites conhecidos:**

- Os limites de tentativa ficam em memória e usam o IP de `X-Forwarded-For`. Em produção, o portal precisa de uma instância só e do Caddy na frente.
- O domínio de um site é único por tenant mesmo depois de arquivado, como diz o spec: um domínio arquivado não pode ser cadastrado de novo sem desarquivar.
- A chave de API do Umami consegue criar equipes; só o código do portal impede isso.
- Os testes de integração deixam linhas no `audit_log`, que só aceita inserção. No CI o banco é descartado; no banco local elas se acumulam.
