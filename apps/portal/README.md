# apps/portal

Portal em Next.js (App Router), com Drizzle ORM, Better Auth e Tailwind. É a única porta de entrada da plataforma: cadastro self-service, login, painéis do tenant e painéis globais do SCF.

Lê as estatísticas web pela API do Umami (com uma conta de serviço, [#58](https://github.com/romulospl/notify/issues/58)) e as métricas de API direto do banco `notify`. O isolamento entre tenants na leitura é responsabilidade do portal: o tenant vem sempre da sessão ([#18](https://github.com/romulospl/notify/issues/18)).

## O que já existe ([#57](https://github.com/romulospl/notify/issues/57))

- Login por e-mail e senha com sessão no servidor (Better Auth, tabelas no banco `notify`).
- Rotas privadas: `/dashboard` (área do tenant) e `/operator` (área do operador SCF, só para o papel `operator`; outros recebem 404).
- O `proxy.ts` redireciona para `/sign-in` quem não tem cookie de sessão; a validação de verdade é feita no servidor (`src/lib/session.ts`).
- O cadastro pela API está desligado até o self-service ([#17](https://github.com/romulospl/notify/issues/17)) e a verificação de e-mail ([#60](https://github.com/romulospl/notify/issues/60)). Contas são criadas pelo script abaixo.
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
DATABASE_URL=postgresql://notify:notify@localhost:5432/notify \
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

Use `--role operator` para um operador SCF. O comando de administração definitivo e o seed de desenvolvimento entram na [#19](https://github.com/romulospl/notify/issues/19).

## Variáveis de ambiente

| Variável | Obrigatória | Uso |
|---|---|---|
| `DATABASE_URL` | Sim | Conexão com o banco `notify` |
| `BETTER_AUTH_SECRET` | Sim | Segredo das sessões (gere com `openssl rand -base64 32` em produção) |
| `BETTER_AUTH_URL` | Não | URL pública do portal (padrão `http://localhost:3000`) |
| `RUN_MIGRATIONS` | Não | `true` aplica as migrações do Drizzle na subida do servidor |

## Banco e migrações

- Esquema em `src/lib/db/schema.ts`; migrações versionadas em `drizzle/`.
- Depois de mudar o esquema: `pnpm db:generate --name <descricao>` e commite o SQL gerado.
- `pnpm db:migrate` aplica as migrações no banco de `DATABASE_URL`.

## Testes

`pnpm test` roda os testes com Vitest. Os de integração (`test/auth.test.ts`) usam o Postgres de `DATABASE_URL` (padrão: o do Compose local) e aplicam as migrações antes de rodar.
