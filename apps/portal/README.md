# apps/portal

Portal em Next.js (App Router), com Drizzle ORM, Better Auth e Tailwind. É a única porta de entrada da plataforma: cadastro self-service, login, painéis do tenant e painéis globais do SCF.

Lê as estatísticas web pela API do Umami (com uma conta de serviço, [#58](https://github.com/romulospl/stellytics/issues/58)) e as métricas de API direto do banco `stellytics`. O isolamento entre tenants na leitura é responsabilidade do portal: o tenant vem sempre da sessão ([#18](https://github.com/romulospl/stellytics/issues/18)).

## O que já existe ([#57](https://github.com/romulospl/stellytics/issues/57))

- Login por e-mail e senha com sessão no servidor (Better Auth, tabelas no banco `stellytics`).
- Rotas privadas: `/dashboard` (área do tenant) e `/operator` (área do operador SCF, só para o papel `operator`; outros recebem 404).
- O `proxy.ts` redireciona para `/sign-in` quem não tem cookie de sessão; a validação de verdade é feita no servidor (`src/lib/access.ts`).
- Cadastro aberto com confirmação de e-mail e recuperação de senha ([#60](https://github.com/romulospl/stellytics/issues/60)); ver a seção "Cadastro e e-mail".
- O IP de quem entra no portal não é gravado na sessão; ele só é usado em memória para o limite de tentativas.

A interface é em inglês, porque o público são os projetos do ecossistema Stellar e o SCF.

## Rodando

Pelo Docker Compose, na raiz do repositório (aplica as migrações na subida):

```bash
docker compose up -d --wait
```

O portal fica em http://localhost:3000. Para desenvolver com recarga automática, suba só o banco e rode o `next dev`:

```bash
docker compose up -d --wait postgres
cd apps/portal
DATABASE_URL=postgresql://stellytics:stellytics@localhost:5432/stellytics \
BETTER_AUTH_SECRET=dev-only-portal-auth-secret-change-me \
pnpm db:migrate && pnpm dev
```

### Criar um usuário

A senha vem da variável `PORTAL_USER_PASSWORD` (mínimo de 12 caracteres), para não ficar no histórico do shell:

```bash
cd apps/portal
read -rs PORTAL_USER_PASSWORD && export PORTAL_USER_PASSWORD
pnpm user:create --email voce@example.com --name "Seu nome"
```

O usuário nasce com e-mail confirmado e sem projeto; ao entrar, cai em `/onboarding`. Esse script não cria operador.

### Seed de desenvolvimento ([#19](https://github.com/romulospl/stellytics/issues/19))

Cria 2 projetos de teste (cada um com dono, um serviço de API e uma chave) e 1 operador SCF. Pode rodar mais de uma vez; o que já existe fica como está. Com `UMAMI_API_KEY` definida, cada projeto ganha também um site no Umami.

```bash
cd apps/portal
read -rs SEED_PASSWORD && export SEED_PASSWORD
pnpm db:seed
```

Contas, todas com a senha de `SEED_PASSWORD`: `owner-a@seed.stellytics.localhost`, `owner-b@seed.stellytics.localhost` e `operator@seed.stellytics.localhost`. Os testes de integração rodam o seed com a senha de teste deles, então o banco local fica com essas contas.

## Operador SCF ([#19](https://github.com/romulospl/stellytics/issues/19))

- Lê todos os projetos, inclusive os removidos: `/operator` lista os projetos com contagens e `/operator/tenants/[tenantId]` mostra membros, sites e serviços. Das chaves de ingestão aparecem só o prefixo e as datas.
- Não é membro de tenant (D2). O banco recusa pôr um operador num tenant e promover um membro a operador (`drizzle/0003_operator_not_member.sql`); quem é do SCF e tem um projeto usa duas contas.
- Só nasce pelo comando de administração (D3), nunca pela tela de cadastro, onde o papel enviado pelo cliente é ignorado. Cada mudança vai para o `audit_log` e encerra as sessões da conta:

```bash
cd apps/portal
read -rs OPERATOR_PASSWORD && export OPERATOR_PASSWORD
pnpm operator:create --email scf@example.org --name "Nome"
pnpm operator:promote --email pessoa@example.org
pnpm operator:demote --email pessoa@example.org
```

## Umami ([#58](https://github.com/romulospl/stellytics/issues/58))

O portal fala com o Umami só por `src/lib/umami/` (o ESLint proíbe importar `src/lib/umami/http.ts` de outro lugar):

- `createSite(ctx, …)` em `src/lib/data/sites.ts` cria o site no Umami e depois grava a linha em `site`; se a gravação falhar, apaga o site no Umami.
- `getSiteStats(ctx, siteId, …)` recebe o ID do site do portal, confere que é do tenant do contexto e só então chama o Umami com o `umami_website_id`. Site de outro tenant devolve nulo sem nenhuma chamada ao Umami.
- `findUmamiInconsistencies()` lista sites do portal que sumiram do Umami e sites do Umami sem linha em `site`.

O portal cria só sites no Umami, nunca usuários nem equipes (ADR 0003).

## Isolamento entre tenants ([#18](https://github.com/romulospl/stellytics/issues/18))

- `src/lib/access.ts` cria os contextos a partir da sessão: `requireTenantContext()` / `getTenantContext()` para membros de tenant e `requireOperatorContext()` para operadores. Os tipos são marcados, então só esse arquivo consegue criá-los.
- Toda leitura e gravação passa por `src/lib/data/` (banco) e `src/lib/umami/` (Umami), com o contexto como primeiro argumento. Funções do operador ficam em `src/lib/data/operator/`.
- O ESLint proíbe importar o cliente do banco, o driver `postgres` e o cliente HTTP do Umami fora dessas pastas. O esquema (`src/lib/db/schema.ts`) pode ser importado em qualquer lugar.
- Quem não tem acesso recebe 404: operador em `/dashboard` é levado a `/operator`, membro de tenant em `/operator` recebe 404, e usuário sem projeto vê um aviso até o cadastro self-service ([#17](https://github.com/romulospl/stellytics/issues/17)).

### Conta de serviço

Um usuário comum do Umami (`stellytics-portal`, papel `user`), autenticado por chave de API. O script abaixo cria o usuário (ou troca a senha dele por uma aleatória, que ninguém guarda) e imprime uma chave nova. A senha de administrador só é usada aqui:

```bash
cd apps/portal
read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
UMAMI_URL=http://127.0.0.1:3001 pnpm umami:service-account
```

O Umami só fica em `127.0.0.1:3001` com o override de desenvolvimento (`infra/compose/umami-port.yaml`, ver o [README da raiz](../../README.md#rodar-localmente)).

Ponha a chave em `UMAMI_API_KEY` (no `.env` da raiz para o Compose) e recrie o portal (`docker compose up -d portal`). Para trocar a chave, rode de novo, atualize o portal e depois rode com `--revoke-old`, que deixa só a chave mais nova.

Use `127.0.0.1`, não `localhost`: se outro programa escutar a mesma porta em IPv6, `localhost` cai nele.

## Serviços de API e chaves de ingestão ([#59](https://github.com/romulospl/stellytics/issues/59))

- Telas: `/services` (lista e criação de serviços) e `/services/[serviceId]` (chaves do serviço: criar e revogar).
- Formato e hash da chave em `src/lib/ingest-key.ts`: `ntf_<prefixo>_<segredo>`, prefixo de 8 caracteres base32 e segredo de 32 bytes em base64url. O banco guarda só o prefixo e o SHA-256 da chave completa; é o contrato com o coletor ([#30](https://github.com/romulospl/stellytics/issues/30)), que lê a visão `ingest_key_active`.
- Funções em `src/lib/data/api-services.ts`. Criar um serviço já gera a primeira chave. Limite de 5 chaves ativas por serviço, garantido com trava na linha do serviço. Criar e revogar chave entram no `audit_log` só com o prefixo.
- A chave completa aparece uma única vez, no retorno da server action, e nunca é registrada em log. Revogar tira a chave da visão do coletor na hora; o cache do coletor faz valer em até 60 segundos.

## Cadastro self-service ([#17](https://github.com/romulospl/stellytics/issues/17))

Um projeto Stellar entra sozinho, sem ajuda do SCF:

1. `/sign-up`: cria a conta e confirma o e-mail pelo link (ver a seção seguinte).
2. `/onboarding`: dá nome ao projeto. O portal cria o tenant `active` e torna a pessoa `owner`, na mesma transação, e registra `tenant.created` no `audit_log`. Só chega aqui quem tem e-mail confirmado e ainda não tem projeto (`requireOnboardingContext()`); quem já tem vai para o painel.
3. `/sites`: cadastra os sites web; cada um vira um site no Umami e mostra o ID que o script de rastreamento usa.
4. `/services`: cadastra os serviços de API; cada um já sai com a primeira chave de ingestão.

Quem ainda não tem projeto e abre uma página do tenant é levado a `/onboarding`. O slug do projeto vem do nome; se já existir, ganha um sufixo aleatório.

## Cadastro e e-mail ([#60](https://github.com/romulospl/stellytics/issues/60))

- `/sign-up` cria a conta e envia o link de confirmação (vale 24 horas). Sem confirmar, a pessoa não entra, então não cria projeto; ao tentar entrar, recebe outro link.
- O link de confirmação abre a sessão e leva a `/dashboard`. Link vencido ou inválido leva a `/email-verified`, que explica o que fazer.
- `/forgot-password` envia um link de redefinição que vale 30 minutos e uma vez só. Trocar a senha encerra todas as sessões.
- Cadastro com e-mail já existente e pedido de redefinição para e-mail sem conta recebem a mesma resposta dos casos normais, sem revelar quem tem conta.
- Limites por IP (em memória, por instância): entrar, 3 a cada 10 segundos; cadastrar, 10 por hora; pedir redefinição ou novo link de confirmação, 5 por hora. Atrás do proxy, o IP vem de `X-Forwarded-For`, então o portal não deve ficar exposto sem o Caddy na frente.
- Os e-mails são só texto (`src/lib/mail.ts`), sem HTML, e nem o destinatário nem o link vão para o log.
- No Compose, os e-mails vão para o Mailpit: caixa de entrada em http://127.0.0.1:8025 e SMTP em `127.0.0.1:1025` (para o `next dev`, use `SMTP_URL=smtp://127.0.0.1:1025`). Em produção, o SMTP vem da IaC ([#14](https://github.com/romulospl/stellytics/issues/14)).

## Variáveis de ambiente

| Variável | Obrigatória | Uso |
|---|---|---|
| `DATABASE_URL` | Sim | Conexão com o banco `stellytics` |
| `BETTER_AUTH_SECRET` | Sim | Segredo das sessões (gere com `openssl rand -base64 32` em produção) |
| `SMTP_URL` | Para e-mail | Servidor SMTP, ex.: `smtp://mailpit:1025` ou `smtps://usuario:senha@host:465`. Sem ele, o portal sobe, mas os e-mails de confirmação e de senha falham (o erro vai para o log) |
| `MAIL_FROM` | Não | Remetente (padrão `stellytics <no-reply@stellytics.localhost>`) |
| `BETTER_AUTH_URL` | Não | URL pública do portal (padrão `http://localhost:3000`) |
| `RUN_MIGRATIONS` | Não | `true` aplica as migrações do Drizzle na subida do servidor |
| `UMAMI_URL` | Não | Endereço interno do Umami (padrão `http://127.0.0.1:3001`, publicado só pelo `infra/compose/umami-port.yaml`; no Compose, `http://umami:3000`) |
| `INGEST_URL` | Não | Public gateway address used in the installation tag on each site's page (default `http://localhost:3002`; `https://INGEST_HOST` in `prod.yaml`) |
| `UMAMI_API_KEY` | Para sites | Chave de API da conta de serviço. Sem ela o portal sobe, mas não cria sites nem lê estatísticas |

## Banco e migrações

- Esquema em `src/lib/db/schema.ts`; migrações versionadas em `drizzle/`.
- O modelo de tenants (`tenant`, `tenant_member`, `site`, `api_service`, `ingest_key` e `audit_log`) segue a seção 3 do [spec do E2](../../docs/specs/e2-tenants-e-controle-de-acesso.md). O `audit_log` só aceita inserções (um gatilho recusa `UPDATE`, `DELETE` e `TRUNCATE`).
- As visões `ingest_site` (gateway web) e `ingest_key_active` (coletor) e as permissões dos usuários `stellytics_ingest` e `stellytics_collector` estão em `drizzle/0002_ingest_views.sql`, escrito à mão. Para SQL que o Drizzle não gera: `pnpm db:generate --custom --name <descricao>`.
- **As migrações exigem os usuários `stellytics_ingest` e `stellytics_collector`**, que só um superusuário cria. No Compose, `infra/compose/postgres/init/02-ingest-roles.sh` roda com o volume vazio. Para um volume que já existe, sem apagar os dados:

  ```bash
  docker compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh
  ```

- Depois de mudar o esquema: `pnpm db:generate --name <descricao>` e commite o SQL gerado.
- `pnpm db:migrate` aplica as migrações no banco de `DATABASE_URL`.

## Testes

`pnpm test` roda os testes com Vitest. Os de integração (`test/auth.test.ts`, `test/tenant-model.test.ts`, `test/umami.test.ts`, `test/access.test.ts` e `test/ingest-keys.test.ts` e `test/email-flows.test.ts`) usam o Postgres de `DATABASE_URL` (padrão: o do Compose local) e aplicam as migrações antes de rodar. Os testes de permissão assumem os papéis de ingestão com `SET ROLE`, por isso o script acima também dá ao usuário `stellytics` o direito de assumi-los (sem herdar nada deles). Os testes do Umami usam um Umami falso (`test/fake-umami.ts`); o job `compose` do CI confere a conta de serviço contra o Umami de verdade.
