# Anti-bot e cadeia de suprimentos

Este documento descreve duas defesas do stellytics e, para cada uma, o que ela impede e o que **não** impede. Tudo o que está aqui foi lido no código da `main`; onde um controle depende de uma ação fora do repositório, isso está dito. Os itens de conta e de GitHub (app do Renovate, relato privado de vulnerabilidades, proteção de branch) não são verificáveis no código: vêm de [`andamento.md`](andamento.md). Mudou o código? Atualize o documento junto.

- [Parte 1: anti-bot e anti-inflação](#parte-1-anti-bot-e-anti-inflação)
- [Parte 2: cadeia de suprimentos](#parte-2-cadeia-de-suprimentos)
- [Lacunas e ações fora do código](#lacunas-e-ações-fora-do-código)

Relacionados: [`arquitetura.md`](arquitetura.md), [`privacidade.md`](privacidade.md), [`deploy.md`](deploy.md), [`SECURITY.md`](../SECURITY.md), [ADR 0002](adr/0002-arquitetura-e-stack.md).

---

## Parte 1: anti-bot e anti-inflação

### Ameaça

Estatísticas de visitas só valem se forem difíceis de inflar. Quem inflar os números de um projeto (para parecer mais usado, ou para sujar o painel de um concorrente) precisa apenas enviar eventos ao endpoint público de ingestão (`POST /e`, em [`services/ingest-web/handler.go`](../services/ingest-web/handler.go)). O ID do site (um UUID) não é segredo: está no HTML de quem instala o script.

O stellytics não tenta separar "humano" de "robô" com certeza. A estratégia é **encarecer** o tráfego falso e **limitar o estrago** de cada origem, sem cookie, sem storage e sem guardar o IP completo (ver [`privacidade.md`](privacidade.md)).

### Camadas, na ordem em que o gateway as aplica

O `event` em [`handler.go`](../services/ingest-web/handler.go) executa as checagens nesta ordem. Os valores abaixo são os padrões de [`internal/config/config.go`](../services/ingest-web/internal/config/config.go). Só alguns são ajustáveis em produção: o [`prod.yaml`](../infra/compose/prod.yaml) repassa ao contêiner apenas `PROOF_SECRET`, `RATE_LIMIT`, `RATE_BURST` e `FINGERPRINT_LIMIT` (por `INGEST_*` no `.env`); mudar os demais exige editar o `prod.yaml`.

| # | Camada | Onde | Limite padrão | Ajustável em produção | Resposta quando falha |
|---|---|---|---|---|---|
| 1 | Limite de taxa por IP truncado (token bucket, em memória) | [`internal/limit`](../services/ingest-web/internal/limit/limit.go) | `RATE_LIMIT` 20 eventos/s, `RATE_BURST` 40 | sim (`RATE_LIMIT`, `RATE_BURST`) | `429` |
| 2 | Tipo de conteúdo e tamanho do corpo | `handler.go` | `text/plain` ou `application/json`; corpo de até 16 KiB (`maxBody`) | não (constante) | `415` / `413` |
| 3 | Prova de execução de JavaScript | [`internal/proof`](../services/ingest-web/internal/proof/proof.go) | `PROOF_BITS` 12, `PROOF_TTL` 10 min | só o segredo; `PROOF_BITS` e `PROOF_TTL` não | `204`, evento descartado |
| 4 | Site existe e aceita ingestão | [`internal/site`](../services/ingest-web/internal/site/site.go) (visão `ingest_site`) | cache de no máximo 1 min (`SITE_CACHE_TTL`) | não | `204`, evento descartado |
| 5 | Limite de fingerprints distintas por IP e site | [`internal/fingerprint`](../services/ingest-web/internal/fingerprint/fingerprint.go) | `FINGERPRINT_LIMIT` 50 por `FINGERPRINT_WINDOW` de 10 min | só `FINGERPRINT_LIMIT`; a janela não | `204`, evento descartado |
| 6 | Repasse ao Umami com payload remontado | [`internal/relay`](../services/ingest-web/internal/relay/relay.go) | só `website`, `hostname`, `url`, `referrer`, `title`, `language`, `screen`; opcional: `RELAY_MAX_INFLIGHT` repasses simultâneos (padrão 0, desligado) e `RELAY_QUEUE_WAIT` 250 ms ([ADR 0011](adr/0011-limite-de-repasses-ao-umami.md)) | sim (padrão desligado) | `204` quando o limite de repasses está ligado e não há vaga; o evento se perde |

Falhas das camadas 3, 4 e 5 respondem `204`, igual ao sucesso, para não dar pista de qual regra barrou nem de se um site existe (spec do E2, seção 6, em [`e2-tenants-e-controle-de-acesso.md`](specs/e2-tenants-e-controle-de-acesso.md)). Isso vale só para essas camadas; outras respostas de `handler.go` aparecem para quem testa:

| Resposta | Quando |
|---|---|
| `400` | IP do cliente ilegível, JSON inválido ou campos fora dos limites (`relay.Decode`), `s` do `GET /c` que não é UUID |
| `413` | corpo maior que 16 KiB |
| `415` | tipo de conteúdo diferente de `text/plain` e `application/json` |
| `429` | limite de taxa por IP truncado |
| `503` | falha na consulta à `ingest_site` (o gateway não deixa passar evento sem conferir o site) |
| `502` | falha no repasse ao Umami |
| `204` (saturação) | sem vaga de repasse dentro de `RELAY_QUEUE_WAIT`; o evento é descartado e contado no log agregado |

A saturação responde `204`, assim como os descartes por site e fingerprint, evitando distingui-los pelo status. Diferenças de tempo entre os caminhos ainda podem fornecer pistas. `GET /c` passa pelo limite de taxa e não consulta a `ingest_site`.

### Prova de execução de JS (`internal/proof`)

Como funciona:

1. O script pede `GET /c?s=<website>`. O gateway devolve um token e o número de bits exigido.
2. O token tem 32 bytes: horário de emissão, 8 bytes aleatórios e um HMAC-SHA-256 truncado em 16 bytes. O HMAC cobre o `website` e usa a chave `PROOF_SECRET` (mínimo de 32 caracteres, validado em `config.go`), com separação de domínio (`stellytics-proof-v1`). Em produção, o segredo vem de `INGEST_PROOF_SECRET` ([`infra/compose/prod.yaml`](../infra/compose/prod.yaml), valor no `.env.production`).
3. O script procura um nonce tal que `SHA-256(token + ":" + nonce)` comece com `PROOF_BITS` bits zero (`solve` em [`packages/tracker/src/tracker.ts`](../packages/tracker/src/tracker.ts), usando `crypto.subtle`) e manda `p:{t,n}` em cada evento.
4. `Issuer.Verify` confere formato, assinatura (comparação em tempo constante com `hmac.Equal`), validade (`PROOF_TTL` de 1 min a 1 h, tolerância de 1 min para relógio adiantado) e o trabalho. A prova nunca é repassada ao Umami.

Com 12 bits, o navegador faz em média cerca de 4 mil hashes por prova, o que é imperceptível; cada prova custa milissegundos de CPU. Quem limita o volume não é a prova, são as camadas de taxa (1) e de fingerprints (5), e os limites abaixo.

Faixas aceitas e valores que desligam controles (validados em `config.go`; o gateway não sobe com valor fora da faixa):

| Variável | Faixa | Efeito de um valor extremo |
|---|---|---|
| `PROOF_BITS` | 0 a 24 | `0` tira o custo da prova (o token assinado continua exigido) |
| `PROOF_TTL` | 1 min a 1 h | quanto maior, mais tempo de reuso de um token |
| `PROOF_SECRET` | 32 caracteres ou mais, ou vazio | vazio: `main.go` sorteia uma chave e avisa no log; os tokens não valem entre reinícios nem entre réplicas. O `prod.yaml` exige o segredo (`INGEST_PROOF_SECRET`) |
| `FINGERPRINT_LIMIT` | 0 a 1000 | `0` desliga a camada de fingerprints |
| `FINGERPRINT_WINDOW` | 1 min a 24 h | janela deslizante da contagem |
| `RATE_LIMIT`, `RATE_BURST` | maiores que 0 | não há valor que desligue a taxa |
| `SITE_CACHE_TTL` | 0 a 1 min | `0` consulta o banco a cada evento |
| `SITE_STALE_TTL` | 0 a 1 h | `0` (padrão) desliga; acima disso, a resposta vencida de um site conhecido vale por esse tempo quando o banco falha. **Janela de risco:** um tenant removido ou site arquivado durante a queda continua aceitando eventos até `SITE_CACHE_TTL` + `SITE_STALE_TTL` |

**O que a prova impede:** `curl`, scripts que repetem um `POST /e` sem passar pelo desafio, e tráfego forjado com o ID de um site sem nunca ter carregado o fluxo do script. Um token de um site não vale para outro (o HMAC cobre o `website`).

**O que a prova NÃO impede** (o próprio comentário do pacote diz que não é uma barreira impossível de contornar):

- **Bots que executam JavaScript**, como navegadores headless (Playwright, Puppeteer) ou qualquer programa que reimplemente o fluxo `GET /c` mais o cálculo do hash. Para eles a prova custa uns milissegundos. A prova tira o tráfego barato e encarece o resto; não distingue pessoa de máquina.
- **Reuso do token dentro da validade.** O token não é de uso único nem fica preso a um IP: o gateway não guarda tokens emitidos (é sem estado). Um mesmo token e nonce valem para qualquer número de eventos durante `PROOF_TTL`. O que limita isso é a camada 1 (taxa por IP) e a 5 (fingerprints).
- **Páginas fora de HTTPS.** Sem `crypto.subtle` (fora de HTTPS ou `localhost`) o script não consegue a prova e os eventos não saem (`fetchProof` devolve nulo). É a escolha segura, mas significa que um tenant com site em HTTP puro não registra visitas.
- **Versão antiga do script.** A v1.0.0 não tem prova e o gateway descarta os eventos dela. A v1.1.0 é a que funciona (CLAUDE.md, seção do script).
- **Eventos vindos de outra origem.** O CORS do `POST /e` é aberto (`Access-Control-Allow-Origin: *`, em `handler.go`) e o gateway não confere o `Origin`; o `hostname` do payload é o que o cliente disser. Quem tem o ID de um site e roda o fluxo completo consegue registrar visitas "daquele site" a partir de qualquer lugar. A defesa contra isso é só a de volume (camadas 1, 3 e 5).

### Fingerprints por IP (`internal/fingerprint`)

Para cada par (IP truncado, site), o `Counter` aceita até `FINGERPRINT_LIMIT` fingerprints distintas numa janela deslizante de `FINGERPRINT_WINDOW`. A fingerprint é o hash (SHA-256, 8 bytes) de `User-Agent`, `Accept-Language`, idioma e tela, e só existe em memória (nada vai para o banco nem para o log). Uma fingerprint já vista na janela sempre passa; as novas além do limite são descartadas com `204`. A conta é separada por site, para que um robô não esgote a cota dos sites de outros tenants que dividem o mesmo IP ou CGNAT.

**O que impede:** um robô que troca o User-Agent a cada request, a partir de um IP só, não infla as métricas além das primeiras 50 fingerprints por janela.

**O que NÃO impede:**

- **Botnets e proxies rotativos.** O limite é por IP truncado (último octeto do IPv4, /48 no IPv6). Quem usa muitos IPs, em redes diferentes, tem uma cota por IP.
- **Falsos positivos.** Uma rede com muita gente (CGNAT, escola, empresa) pode ter mais de 50 combinações distintas em 10 minutos num mesmo /24; as visitas excedentes somem das métricas. O limite é um equilíbrio ajustável, não uma verdade.
- **Persistência.** O estado é em memória, por processo. Reiniciar o gateway zera as contas, e com mais de uma réplica cada uma conta separado. Hoje a produção tem uma instância ([`prod.yaml`](../infra/compose/prod.yaml)), então o segundo ponto ainda não aparece.

### Limite de taxa (`internal/limit`)

Token bucket por IP truncado (20 eventos/s com rajada de 40, nos padrões), em memória, com limpeza de chaves paradas há mais de 10 minutos. Vale para `POST /e` e para `GET /c`. Pelo mesmo motivo acima, é por processo e não detém um ataque distribuído. A confiança no IP do cliente depende de `TRUSTED_PROXIES` (o `X-Forwarded-For` só vale vindo deles; ver `internal/clientip`).

### O que o gateway nunca confia no cliente

O payload repassado ao Umami é montado de novo com sete campos. `ip`, `userAgent`, `id` e `timestamp` do cliente nunca são repassados: o Umami os aceitaria e o cliente poderia trocar IP ou sessão. O Umami recebe o IP já truncado pelo header de `CLIENT_IP_HEADER`.

### Anti-inflação na API

O fluxo de API não usa prova de JS: a autenticação é a chave de ingestão, e o `tenant.id` vem sempre dela, nunca de atributo do cliente (ver [`e5-pipeline-de-api.md`](specs/e5-pipeline-de-api.md) e `services/collector/components/ingestkeyauth` e `tenantattr`). Isso impede um tenant de gravar métricas em nome de outro; **não** impede um tenant de enviar números falsos sobre o próprio serviço. A chave pode ser revogada no portal (`/services`) e a revogação vale em até 60 s (cache `INGEST_KEY_CACHE_TTL`). O teto de 500 rotas por serviço e dia (`{other}`) limita a cardinalidade que um cliente consegue criar.

### Como o anti-bot é testado

- Testes Go de cada pacote (`proof_test.go`, `fingerprint_test.go`, `limit_test.go`); nos testes, `proof.Solve` faz o papel do script.
- Testes do script em `packages/tracker/test/`.
- O e2e do gateway (`services/ingest-web/e2e/`, job `compose` do CI) exercita o fluxo completo com banco e Umami reais.

Não há teste de carga nem medição de taxa de falso positivo em tráfego real. Os limites padrão são estimativas conservadoras, a serem calibradas com os pilotos (E8).

---

## Parte 2: cadeia de suprimentos

### Ameaça

O stellytics serve um script que roda no site de cada tenant e imagens que processam dados de vários projetos. Os ataques que importam: um script adulterado entregue aos visitantes dos tenants (como em ataques a CDNs de terceiros), uma dependência maliciosa publicada e adotada logo em seguida, uma action de CI comprometida, e uma imagem trocada no deploy.

### Controles aplicados no repositório

| Controle | O que faz | Onde está |
|---|---|---|
| **Script de versão fixa e imutável** | Cada versão fica em `/s/vX.Y.Z/n.js` com cache de um ano e `immutable`; o gateway nunca altera o arquivo. O script não se atualiza sozinho: o tenant troca o caminho e o hash no próprio HTML. | `packages/tracker/published/`, `services/ingest-web/handler.go` (`script`, serve `SCRIPT_DIR` com `os.Root`) |
| **SRI (sha384) por versão** | Hash de cada versão em `published/sri.json`, usado no `integrity` do snippet de instalação (com `crossorigin="anonymous"`). Se o arquivo servido mudar, o navegador recusa. | `packages/tracker/published/sri.json`, `packages/tracker/README.md`, `examples/README.md` |
| **Imutabilidade verificada no CI** | `test/published.test.ts` falha se um arquivo publicado mudar, se faltar o SRI de uma pasta, ou se o código atual não bater com a versão do `package.json` (isso inclui uma atualização do esbuild que mude a saída). `pnpm release` do tracker se recusa a sobrescrever uma versão. | `packages/tracker/test/published.test.ts`, `packages/tracker/scripts/release.ts` |
| **Nomes que ad blockers não barram** | Evita que o script e os endpoints sejam bloqueados (e que tenants sejam tentados a hospedar cópias próprias, sem SRI). O workflow `adblock` baixa EasyList, EasyPrivacy, as listas padrão do uBlock Origin e a de Peter Lowe e falha se alguma bloquear `/s/vX.Y.Z/n.js`, `/e` ou `/c`. Roda em PRs que mexem no script ou nas rotas, na `main` e todo dia. Está fora do agregador `ci` de propósito (as listas mudam sem mudança no código). | `.github/workflows/adblock.yml`, `packages/tracker/scripts/check-adblock.ts`, `packages/tracker/docs/ad-blockers.md` |
| **Dependências travadas** | `pnpm-lock.yaml` e `services/go.sum` commitados; o CI instala com `pnpm install --frozen-lockfile`, o `Dockerfile` do portal também. Versões exatas nos `package.json`. | `.github/workflows/ci.yml`, `apps/portal/Dockerfile`, `CONTRIBUTING.md` |
| **Espera de 14 dias** | O pnpm recusa releases com menos de 14 dias (`minimumReleaseAge: 20160`, em minutos) e o Renovate só propõe releases com pelo menos 14 dias (`minimumReleaseAge` e `internalChecksFilter: strict`). Dá tempo para a comunidade achar e retirar uma versão maliciosa. Correções críticas ou altas podem receber exceção específica e documentada ([runbook](runbooks/vulnerabilidades.md)); o pnpm exige sua própria exceção. Os módulos do Collector OTel sobem juntos, na mesma release. | `pnpm-workspace.yaml`, `renovate.json`, `CLAUDE.md` |
| **Renovate** | Atualizações por PR, `rangeStrategy: pin`, `gomodTidy`, versão maior só depois de aprovada no Dependency Dashboard (atualizações de segurança passam direto, desde que os alertas de segurança do repositório estejam ativos, o que é ação da conta), Umami nunca agrupado nem automático, Postgres sem salto de versão maior, actions agrupadas. O manager `docker-compose` lê `infra/compose/*.yaml`. | `renovate.json` |
| **Actions fixadas por SHA** | Todo `uses:` dos workflows tem o SHA do commit, com a tag em comentário (`helpers:pinGitHubActionDigests` mantém isso). Permissões mínimas por workflow (`contents: read`, elevadas só nos jobs que precisam, como `id-token: write` na assinatura). | `.github/workflows/ci.yml`, `release.yml`, `adblock.yml`, `dependencies.yml` |
| **Imagens por digest** | Imagens base nos `Dockerfile` (`node`, `golang`) e no Compose (`postgres`, `umami`, `mailpit`, `caddy`, `otel/opentelemetry-collector`) fixadas por tag e digest. A imagem do Postgres de produção (Debian) também. As imagens finais do Go são `scratch`: só o binário, sem shell nem gerenciador de pacotes. O Go compila com `-trimpath` e `CGO_ENABLED=0`. | `apps/portal/Dockerfile`, `services/*/Dockerfile`, `infra/compose/*.yaml`, `infra/compose/postgres/Dockerfile` |
| **Licenças aprovadas pela OSI** | Regra do projeto: toda dependência precisa de licença OSI. Já pesou em decisões (TimescaleDB, licença TSL, descartado no [ADR 0002](adr/0002-arquitetura-e-stack.md); OpenTofu no lugar do Terraform, licença BUSL, no [ADR 0004](adr/0004-hospedagem-e-backup.md), depois removido junto com a IaC no [ADR 0016](adr/0016-producao-em-vps.md)). O repositório é MIT. | `CONTRIBUTING.md`, `LICENSE`, ADRs |
| **Varredura de vulnerabilidades** | Três checagens, uma vez por dia e também na `main` e em PRs que mexem em manifestos, lockfiles ou na versão do Go dos `Dockerfile` (sem mudança de manifesto, só a execução diária pega advisory novo). `govulncheck` (golang.org/x/vuln v1.9.0) em `services/`, com o Go dos `Dockerfile` (é a biblioteca padrão dele que vai para produção), falha só em vulnerabilidade **alcançável** pelo código. `pnpm audit --prod` falha em `high` ou `critical`; `moderate` e `low` só são listadas. Uma segunda passada sem `--prod` só **lista** o que há em devDependencies (informativo, não falha), porque ferramentas de build como o esbuild do `packages/tracker`, que gera o `n.js` servido a todos os tenants, ficam fora do `--prod`. O script distingue "achei" de "não consegui consultar" (rede, registry fora): os dois deixam o job vermelho, mas nunca vira verde em silêncio. | `.github/workflows/dependencies.yml`, `scripts/deps/audit-pnpm.mjs` |
| **Verificação de licenças** | Allowlist de ids SPDX aprovados pela OSI em `scripts/licenses/allowed.json`, conferida contra as dependências de produção do pnpm (`pnpm licenses list --prod`) e do Go (`go-licenses` v2.0.1, Apache-2.0, só pacotes que entram nos binários). Falha com a lista de pacotes e licenças fora da lista. Sem licença, `UNLICENSED`, `Unknown` e expressão inválida falham; `OR` (dual license) passa se uma alternativa for permitida, `AND` exige todas. Exceção pontual só com motivo, data e vencimento no mesmo arquivo. Lista vazia é erro, não "zero dependências". | `.github/workflows/dependencies.yml`, `scripts/licenses/`, `scripts/deps/check-licenses.mjs`, `CONTRIBUTING.md` |
| **Release com SBOM** | Ao publicar uma release, o workflow gera um SBOM SPDX do repositório (syft) e o anexa à release. | `.github/workflows/release.yml` (job `sbom`) |
| **Imagens assinadas e atestadas** | Para cada `Dockerfile` em `apps/*` e `services/*`, publica no GHCR com a tag da versão e a tag do commit, assina com cosign **sem chave** (identidade OIDC do GitHub Actions) e anexa o SBOM da imagem como atestado, tudo por digest. | `.github/workflows/release.yml` (job `image`) |
| **Imagens próprias no deploy** | Por padrão o `deploy.sh` constrói portal, gateway, coletor e rollup a partir do checkout (`docker compose up --build`). As imagens assinadas da release podem ser usadas por digest (`PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE`, `ROLLUP_IMAGE`), mas **nada confere a assinatura no deploy**: é um controle mais fraco do que verificar antes de subir. | `deploy.sh`, `infra/compose/prod.yaml`, [`deploy.md`](deploy.md) |
| **Canal de relato de vulnerabilidades** | Política, prazos por severidade (3 dias úteis para confirmar, 14 dias para crítica) e escopo; inclui o script `/s/vX.Y.Z/` nas versões suportadas. | [`SECURITY.md`](../SECURITY.md) |

Como verificar uma imagem publicada e o SBOM atestado: ver o [`README.md`](../README.md), seção "Cadeia de suprimentos".

### Dependências e revisão

- **Revisão por PR.** Toda atualização do Renovate vira PR e passa pelo CI (lint, tipos, testes, `go vet`, `go test -race`, testes com Compose). O Umami, que é o componente de terceiros mais sensível, só sobe por PR revisado, com release de pelo menos duas semanas (CLAUDE.md).
- **Poucas dependências no caminho crítico.** O gateway e o rollup são Go com poucas bibliotecas e imagem `scratch`; o script do navegador não tem dependência de execução (é empacotado com esbuild).

### Limites honestos da cadeia de suprimentos

- **A assinatura prova origem, não ausência de bug.** Um `cosign verify` (feito à mão; o deploy não o roda) confirma que a imagem saiu do `release.yml` numa tag `v*` do repositório. Se o repositório ou uma conta de mantenedor for comprometido e publicarem uma release, a imagem sairá assinada. A defesa aí é a proteção de conta (2FA) e a revisão, que estão fora do código.
- **A varredura de dependências não tem alcance total.** O `pnpm audit` e o `govulncheck` só conhecem advisories já publicados (nada contra uma dependência maliciosa nova, para isso vale a espera de 14 dias). O `pnpm licenses` lê o `node_modules` da plataforma do CI: dependências opcionais de outras plataformas (binários nativos de macOS ou Windows) não são conferidas e podem ter licença diferente do pacote principal (o `sharp` é Apache-2.0, mas o `@img/sharp-libvips-*` é LGPL-3.0-or-later). O `pnpm audit --prod` não cobre devDependencies; a passada informativa as lista, mas não bloqueia, e o esbuild que gera o script de rastreamento é um caso em que isso importa. O `govulncheck` mostra traces de `loadtest` e `internal/pgtest` como exemplos de alcance; não os filtro, porque o relatório é o mesmo e a vulnerabilidade também é alcançável pelo código dos serviços. O `go-licenses` classifica pelo texto do arquivo de licença; um módulo sem arquivo aparece como `Unknown` e falha. O workflow `dependencies` fica fora do agregador `ci` (o resultado muda sem mudança no código), então não bloqueia merge e depende de alguém olhar o vermelho.
- **A `main` não tem proteção de branch**, por decisão registrada em [`andamento.md`](andamento.md): o CI roda mas não bloqueia merge nem push direto. Um push direto na `main` não passa por revisão. Se a proteção for ligada, exigir só o check `ci`.
- **Imagens de terceiros não têm assinatura conferida.** Umami, Caddy e as demais imagens de terceiros têm só digest fixado. O Postgres de produção é construído no próprio host (`docker compose up --build`) a partir de base por digest, sem assinatura.
- **O `cosign verify` não amarra o digest a uma release específica.** Ele confere identidade (workflow `release.yml` em tag `v*`) e emissor, não qual release o digest deveria ser; quem usa as imagens da release escolhe o digest que preenche em `PORTAL_IMAGE` etc.
- **A regex de identidade aceita qualquer tag `v*`**, não só as de releases aprovadas. Quem puder criar uma tag e publicar uma release (permissão de escrita no repositório) produz uma imagem aceita.
- **Builds não são verificados como reproduzíveis.** Há passos que ajudam (`-trimpath`, lockfiles, bases por digest, `CGO_ENABLED=0`), mas o `apt-get install` de `curl` em `infra/compose/postgres/Dockerfile` não tem versão fixa (muda com o repositório Debian), e nenhum job reconstrói a imagem e compara o digest, e o build do portal (Next.js) não foi avaliado quanto a isso. Não afirmamos reprodutibilidade bit a bit. Os SBOMs e a atestação dão rastreabilidade, não reprodutibilidade.
- **O SBOM não é conferido automaticamente.** Ele é publicado e atestado, mas nenhum passo o compara com uma base de vulnerabilidades.
- **Não há verificação automática de licenças nem varredura de vulnerabilidades no CI.** A regra da licença OSI é uma regra de revisão (CONTRIBUTING). Não há `pnpm audit`, `govulncheck`, Dependency Review ou equivalente nos workflows; o que pega vulnerabilidade conhecida hoje é o Renovate (atualização de segurança) quando estiver instalado. Ver a próxima seção.
- **A espera de 14 dias reduz o risco, não o elimina.** Uma versão maliciosa que passe despercebida por mais de 14 dias é instalada. Atualizações de segurança do Renovate passam sem essa espera de propósito, pelo outro lado do mesmo risco.
- **Imagens fixadas por digest ficam velhas.** Digest fixo significa que correções de segurança da imagem base só entram por PR do Renovate (ou à mão).
- **As quatro imagens próprias não são verificadas no deploy:** `portal`, `ingest-web`, `collector` e `rollup` são construídas do checkout por padrão; passadas por digest, vêm da release assinada, mas sem `cosign verify` ([ADR 0016](adr/0016-producao-em-vps.md)).
- **O SRI só protege quem o usa.** Um tenant que omitir o atributo `integrity` do snippet recebe o script sem conferência (ainda assim o gateway só serve arquivos imutáveis). O `integrity` está nos exemplos e no README do script, mas não há como forçá-lo.
- **Se o `ingest_host` for comprometido**, o script servido pode mudar, e só o SRI (quando o tenant o usa) barra a troca. As mitigações são a imagem `scratch` e o `published/` imutável por teste; o deploy não exige imagem assinada.

---

## Lacunas e ações fora do código

| Item | Estado | Ação |
|---|---|---|
| App do Renovate | **Não instalado.** O `renovate.json` não tem efeito sem ele (pendência da #55 em [`andamento.md`](andamento.md)). Sem o Renovate, não há PR automático de atualização, nem alerta de segurança, e a regra de 14 dias vale só para o pnpm. | Ação da conta: instalar o app em github.com/apps/renovate para este repositório e validar o Dependency Dashboard. |
| Relato privado de vulnerabilidades | Só existe em repositório público. | Ligar *Settings, Code security, Private vulnerability reporting* ao abrir o repositório (pendência da #56). |
| Proteção da `main` | Desligada por decisão. | Se ligada, exigir o check `ci` e revisão. |
| 2FA e proteção das contas de mantenedores | Não é verificável pelo repositório. | Ação da organização. |
| Verificação de build reproduzível | Não existe. | [#136](https://github.com/romulospl/stellytics/issues/136) (builds reproduzíveis verificados). |
| Calibragem dos limites anti-bot | Padrões não medidos com tráfego real. | Calibrar nos pilotos (E8). |
| Replicação do gateway | Limites em memória por processo. | Se houver mais de uma réplica, mover os contadores para um armazenamento compartilhado ou aceitar a cota por réplica. |

## Resumo dos critérios da issue #41

- **Estratégia anti-bot descrita com limites usados:** a Parte 1 lista cada camada, o valor padrão e a variável que o muda, mais o que cada uma não impede.
- **Medidas de cadeia de suprimentos descritas e aplicadas no repositório:** a Parte 2 aponta o arquivo de cada medida. Estão aplicadas no repositório: script imutável com SRI, lockfiles, espera de 14 dias, `renovate.json`, actions por SHA, imagens por digest, SBOM e imagens assinadas (o deploy não verifica a assinatura: por padrão constrói do checkout). **Dependem de ação fora do código:** a instalação do app do Renovate e as proteções de conta e de branch. **Também estão aplicadas:** varredura de vulnerabilidades (`govulncheck`, `pnpm audit`) e verificação de licenças contra uma allowlist OSI, no workflow `dependencies`. **Não existe ainda:** build reproduzível verificado; isso está dito acima em vez de prometido.
