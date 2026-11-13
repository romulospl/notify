# Como contribuir

Obrigado pelo interesse no notify. Este guia explica como preparar o ambiente, rodar os testes e enviar mudanças.

## Antes de começar

- **Bugs e dúvidas:** abra uma [issue](https://github.com/romulospl/notify/issues/new/choose) com o modelo adequado.
- **Vulnerabilidades:** não abra issue pública; siga o [`SECURITY.md`](SECURITY.md).
- **Mudanças grandes ou de arquitetura:** abra uma issue antes de programar. Decisões de arquitetura viram um ADR em [`docs/adr/`](docs/adr/README.md), a partir do [template](docs/adr/template.md). ADR aceito não é reescrito: crie outro e marque o antigo como substituído.

## Ambiente

Requisitos: Node.js 24 ou mais novo, pnpm 10 (`corepack enable`), Go 1.26 e Docker com Compose v2.

```bash
pnpm install                 # dependências TypeScript
docker compose up -d --wait  # Postgres e Umami locais
```

O passo a passo do ambiente local, com portas e acessos, está no [README](README.md#ambiente-local-docker-compose).

## Testes

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Para o código Go, de dentro de `services/`:

```bash
gofmt -l .
go vet ./...
go test -race ./...
```

Testes de integração usam um Postgres real, lido de `DATABASE_URL` (no ambiente local, `postgresql://notify:notify@localhost:5432/notify`). O CI roda tudo isso em cada PR.

Regras que os testes precisam cobrir:

- **Isolamento entre tenants:** todo acesso a dados novo precisa de teste mostrando que um tenant não vê dados de outro.
- **Privacidade:** o IP completo nunca é persistido; nada de cookies ou storage no navegador.
- **Normalização de rotas:** cada regra com casos positivos e negativos.

## Dependências

- Toda dependência precisa de licença aprovada pela [OSI](https://opensource.org/licenses).
- Fixe versões exatas e commite o lockfile (`pnpm-lock.yaml`, `services/go.sum`). O CI falha se o lockfile estiver desatualizado.
- Só adote releases com pelo menos 14 dias. O pnpm já recusa versões mais novas (`minimumReleaseAge`), e o Renovate segue a mesma regra.
- Actions do GitHub fixadas por SHA, com a tag em comentário.

## Commits e pull requests

Commits seguem o [Conventional Commits 1.0.0-beta.4](https://www.conventionalcommits.org/pt-br/v1.0.0-beta.4/), **sempre em inglês**:

```
<type>[optional scope]: <description>

[optional body]

[optional footer]
```

- Tipos: `feat`, `fix`, `docs`, `chore`, `style`, `refactor`, `perf`, `test`, `ci`, `build` e `improvement`.
- Escopo: a parte do código afetada, por exemplo `feat(collector):`, `fix(tracker):`, `docs(adr):`.
- Descrição no imperativo, curta e em minúsculas: `feat(collector): add Stellar address normalization`.
- Quebra de compatibilidade: `BREAKING CHANGE: <descrição>` no corpo ou no rodapé, ou `!` antes dos dois-pontos.
- Feche a issue pelo rodapé: `closes #32`.

Pull requests:

- Um assunto por PR, com título no mesmo padrão dos commits.
- Descreva o que mudou e como testou.
- O CI precisa estar verde para o merge.

Documentação, ADRs e issues são escritos em português do Brasil.

## Licença

Ao contribuir, você concorda que sua contribuição será licenciada sob a [licença MIT](LICENSE) do projeto.
