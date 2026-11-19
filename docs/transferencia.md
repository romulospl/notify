# Transferência para um operador da comunidade

Plano e procedimento para passar a operação do stellytics a um operador da comunidade (por exemplo, o próprio SCF ou uma equipe indicada por ele): repositório, imagens, infraestrutura, domínio, dados e responsabilidades ([#54](https://github.com/romulospl/stellytics/issues/54), épico [E9](https://github.com/romulospl/stellytics/issues/9)).

> **Status.** O **plano** está escrito a partir do que o repositório tem hoje (`docs/deploy.md`, `docs/runbooks/`, `release.yml`, `infra/`). O **procedimento de migração de dados foi executado de verdade, localmente**, com os scripts e o resultado descritos em [Migração de dados](#migração-de-dados-testada). **Nada mais foi executado:** nenhuma transferência de repositório, de domínio ou de conta real, nenhuma restauração contra um bucket S3 real, nenhum `init.sh` ou `deploy.sh` numa VPS real. A lista completa está em [O que não foi testado](#o-que-não-foi-testado). Pelo critério da issue, **a #54 só fecha quando o novo operador roda o sistema sozinho** ([Critérios de aceite](#critérios-de-aceite-da-transferência)); este documento não cumpre isso.
>
> **A produção ainda não foi aplicada** (`docs/deploy.md`, `docs/privacidade.md`). Isso é uma vantagem: as escolhas que são caras de desfazer depois (domínio e quem o possui, [host da ingestão](#decisão-domínio-e-host-da-ingestão)) ainda podem ser feitas já com o dono final. Se o primeiro deploy for feito pelo próprio operador da comunidade, boa parte deste documento vira só a lista do que ele deve ter desde o início.

## O que muda de mãos

"Hoje" é o que o repositório assume (`romulospl/stellytics`, uma pessoa operando). Cada linha diz o que precisa trocar e onde.

| O quê | O que acontece | Onde está no repositório |
|---|---|---|
| **Repositório GitHub** (código, issues, releases, tags, `SECURITY.md`) | Transferência em *Settings → Danger Zone → Transfer* para a organização do novo operador. O GitHub mantém redirecionamento das URLs do repositório e leva issues, releases e tags. **Não leva** o Project `romulospl/projects/1` (é do usuário) nem as configurações de segurança: reative o relato privado de vulnerabilidade (*Security → Report a vulnerability*) e confira os mantenedores. Os links `https://github.com/romulospl/stellytics/...` na documentação continuam funcionando pelo redirecionamento; troque-os depois, sem pressa | `.github/ISSUE_TEMPLATE/config.yml`, `SECURITY.md`, `README.md`, `CONTRIBUTING.md`, `docs/` |
| **GitHub Actions e segredos** | Ligue o Actions na organização nova. Hoje nenhum workflow usa segredo do repositório além do `GITHUB_TOKEN` (conferido: não há `secrets.` fora dele em `.github/workflows/`), então **não há segredo de Actions para migrar**. O `release.yml` publica no GHCR com esse token e assina por OIDC; o `adblock.yml` roda por `cron` (`17 6 * * *`) e continua depois da transferência | `.github/workflows/` |
| **Organização, pacotes GHCR e imagens** | O `release.yml` publica em `ghcr.io/${{ github.repository }}/<nome>`, então **a primeira release feita no repositório novo publica no namespace novo** (`ghcr.io/<org-nova>/stellytics/portal` etc.). As imagens antigas **ficam** em `ghcr.io/romulospl/stellytics/...`: não assuma que a transferência do repositório move os pacotes (confira, e, se precisar, transfira cada pacote pela página dele). Pacotes novos nascem **privados**. Por padrão o `deploy.sh` constrói as imagens a partir do checkout e não usa o GHCR; quem preferir as imagens da release as passa por digest (`PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE`, `ROLLUP_IMAGE` no `.env.production`) e precisa deixar os pacotes públicos, senão a VPS não os baixa | `.github/workflows/release.yml`, `infra/compose/prod.yaml` |
| **Identidade do cosign** | A assinatura é keyless e carrega o caminho do workflow que a gerou (hoje `^https://github.com/romulospl/stellytics/\.github/workflows/release\.yml@refs/tags/v`); as imagens das releases do repositório novo carregam a identidade da organização nova. **O deploy não confere assinatura**: o `deploy.sh` constrói do checkout por padrão, e imagens passadas por digest não são verificadas automaticamente. Quem quiser conferir roda o `cosign verify` da Fase 1 à mão | `.github/workflows/release.yml` |
| **App do Renovate** | O Renovate é um app do GitHub instalado na conta do dono: o novo dono instala o app na organização e habilita o repositório. O `renovate.json` (14 dias de espera, aprovação no Dependency Dashboard para versões maiores, Umami à parte) vai junto com o código. O Dependency Dashboard é uma issue e vem com o repositório | `renovate.json`, `docs/runbooks/atualizacao-do-umami.md` |
| **Domínio e DNS** | Quatro nomes: alias e portal, ingestão web e ingestão de API. **É a parte que mais prende**: os scripts instalados nos sites dos tenants carregam o host da ingestão (ver [Decisão](#decisão-domínio-e-host-da-ingestão)). Os registros são criados à mão ([ADR 0016](adr/0016-producao-em-vps.md)), então nada no repositório os move | `docs/deploy.md` passo 2 |
| **VPS e provedor** | O novo operador escolhe o **próprio provedor** e prepara uma VPS com `init.sh` e `deploy.sh` (`docs/deploy.md`). Não se transfere infraestrutura; recria-se e migra-se **os dados** (abaixo). A VPS antiga fica ligada até o fim do período de reversão | `init.sh`, `deploy.sh`, `infra/compose/prod.yaml` |
| **Armazenamento S3 e bucket de backup** | Bucket novo, na conta nova, com credenciais S3 novas (`WALG_S3_PREFIX`, `WALG_S3_ENDPOINT`, `WALG_S3_REGION`, `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY`). Os backups do operador antigo **não são migrados no caminho recomendado**: o novo operador começa a própria linha de backups com `systemctl start stellytics-backup` logo depois da migração. O bucket antigo é guardado pelo período de reversão e depois apagado, junto com a chave de cifra antiga | `docs/runbooks/backup-e-restauracao.md` |
| **`WALG_LIBSODIUM_KEY`** | Pelo caminho **lógico** (recomendado), o novo operador **gera uma chave nova** e a chave antiga **não passa de mãos**: quem a tem consegue ler os backups antigos, que contêm todos os dados (inclusive hashes de senha e sessões do portal), então ela some com o bucket antigo. Pelo caminho **físico** (WAL-G), a chave antiga é necessária para ler o bucket copiado e precisa ser entregue por canal seguro; depois da migração, comece um bucket e uma chave novos e descarte a antiga. Ela **não é rotacionável** (`docs/runbooks/rotacao-de-segredos.md`), por isso a troca de operador é a oportunidade natural de gerar outra | `.env.production.example` |
| **SMTP** | O novo operador contrata o próprio provedor e ajusta `SMTP_URL`, `MAIL_FROM` e SPF, DKIM e DMARC do domínio do remetente. Sem SMTP ninguém se cadastra (e-mail confirmado é obrigatório), e a recuperação de senha também depende dele | `docs/deploy.md` ("O que você precisa") |
| **Segredos do `.env.production`** | Tabela abaixo: quase todos são **gerados de novo** (o `init.sh` gera os vazios), três merecem cuidado | `.env.production.example` |
| **Contas de operador do SCF** | As contas existem no banco (`user.role = 'operator'`) e **migram com os dados**. O novo operador cria as suas com `pnpm operator:create` (ou `operator:promote`) e rebaixa as antigas com `operator:demote` (grava no `audit_log` e encerra as sessões). As **chaves de leitura do SCF** (`/api/v1`, tabela `operator_api_key`) também migram e continuam valendo: quem as usa precisa saber, e o novo operador decide se as revoga e reemite | `apps/portal/scripts/operator.mjs`, `docs/adr/0006-api-de-leitura-do-scf.md` |
| **Senha de `admin` do Umami** | **Migra com o banco** (o usuário `admin` está no banco `umami`; conferido no teste). Quem operava antes a conhece: o novo operador troca a senha pelo túnel **antes de qualquer outra coisa** depois da migração | `docs/deploy.md` passo 5 |
| **Monitoramento externo** | O novo operador sobe o próprio host de monitoramento (`infra/monitoring/configure.sh` e `docker compose up -d --wait`), com os próprios `ALERT_EMAIL`, SMTP de alerta e `DEADMAN_URL`. Desligue o antigo só depois | `infra/monitoring/` |
| **Chaves SSH e acesso ao provedor** | Do novo operador, na conta nova. O operador antigo perde acesso ao apagar os próprios recursos; na VPS e no host de monitoramento antigos, revogue as chaves ao fim do período de reversão | `docs/runbooks/rotacao-de-segredos.md` |
| **Chaves de ingestão dos tenants (`ntf_...`)** | Migram com o banco (guarda só prefixo e SHA-256) e **continuam válidas**: nenhum tenant precisa trocar a chave | `apps/portal/src/lib/ingest-key.ts` |
| **Entidade legal, DPA e aviso de privacidade** | Quem opera é o **controlador** dos dados de conta e o **operador (processor)** dos dados dos tenants (`docs/privacidade.md`). A troca de operador troca esse contrato: precisa de definição jurídica e de aviso aos tenants **antes** da janela. Não resolvido aqui | `docs/privacidade.md` |
| **Caminho do módulo Go** (`github.com/romulospl/stellytics/services`) | **Não precisa mudar**: o módulo só é usado dentro do repositório, e o `go.mod` não depende do dono para compilar. Renomear é opcional e mexe em dezenas de arquivos | `services/go.mod` |

### Segredos do `.env.production`

| Segredo | Na migração |
|---|---|
| `POSTGRES_PASSWORD`, `UMAMI_DB_PASSWORD`, `STELLYTICS_DB_PASSWORD`, `STELLYTICS_INGEST_DB_PASSWORD`, `STELLYTICS_COLLECTOR_DB_PASSWORD` | **Gere de novo.** No caminho lógico os papéis do banco novo são criados pelos scripts de `infra/compose/postgres/init/` com as senhas novas; o teste usou senhas diferentes das da origem em todos eles |
| `PORTAL_AUTH_SECRET` | **Mantenha** se quiser que os usuários continuem logados e os links de e-mail em andamento valham: no teste, a sessão criada na origem continuou válida no destino com o mesmo valor. Trocar derruba todas as sessões (efeito esperado, `rotacao-de-segredos.md`); a troca de valor **não foi testada** na migração |
| `UMAMI_APP_SECRET` | **Mantenha.** Só se testou com o mesmo valor. O `rotacao-de-segredos.md` diz que trocá-lo derruba as sessões do Umami e pode invalidar a chave de API; o efeito sobre a contagem de visitantes do mês **não foi medido** |
| `UMAMI_API_KEY` | **Confira.** Se a chave vive no banco do Umami, ela migra e continua valendo; **isso não foi testado** (o teste não criou a conta de serviço). Se o portal receber 401 do Umami, gere outra (`docs/deploy.md`, passo 5, item 3) |
| `INGEST_PROOF_SECRET` | **Gere de novo** (os desafios duram minutos; alguns eventos podem ser descartados na virada) |
| `SMTP_URL`, e `SMTP_PASSWORD` e `DEADMAN_URL` do monitoramento | Do novo operador |
| `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY`, `WALG_LIBSODIUM_KEY` | **Novos** (caminho lógico); ver a linha da chave acima |

## Decisão: domínio e host da ingestão

O script de rastreamento é instalado em sites de terceiros com `src="https://<host da ingestão>/s/vX.Y.Z/n.js"` e **manda os eventos de volta para a origem de onde foi carregado** (`POST /e`, `CLAUDE.md`). Os arquivos `v1.x` são imutáveis, com SRI, e o gateway precisa continuar respondendo por eles. Trocar o host da ingestão exige que **cada tenant edite o HTML dos próprios sites**; esquecer um site é perder os dados dele em silêncio. Por isso a regra é: **o nome do host da ingestão não pode mudar.**

| Opção | O que é | Quando serve |
|---|---|---|
| **A. O domínio muda de dono** (recomendada) | Transferir o registro do domínio (ou ao menos a zona DNS) ao novo operador. Os nomes continuam os mesmos e **nenhum tenant faz nada** | Sempre que o domínio for do projeto e não de uma pessoa |
| **B. O domínio fica com o operador antigo** | Ele só repõe os registros A e AAAA para o IP novo | **Só como fase transitória.** Contradiz o critério "o novo operador roda sozinho": se o dono do domínio some, a ingestão cai |
| **C. Domínio novo** | Redirecionamento permanente do portal e transição longa da ingestão | Último recurso. O **redirecionamento** serve ao portal (navegadores em `GET`), **não** à ingestão: um `POST` de `fetch` entre origens não deve depender de redirecionamento. O host antigo precisa **continuar servindo o gateway por muito tempo** |

**A opção C exige uma mudança que o repositório ainda não tem.** O Caddyfile (`infra/caddy/Caddyfile`) conhece um host de ingestão e não mantém um alias legado para ele. Para a transição seria preciso servir o gateway nos dois nomes por tempo suficiente, redirecionar o portal antigo e atualizar certificados, DNS e o `.env.production`. **Isso é uma proposta, não está implementado nem testado**; se a opção C for a escolhida, abra uma issue e implemente antes da janela. Mudar o host do portal também derruba as sessões (o cookie é do host) e muda a `BETTER_AUTH_URL`.

**Host neutro** ([`packages/tracker/docs/ad-blockers.md`](../packages/tracker/docs/ad-blockers.md)): o host da ingestão deve ser curto e neutro (`e.<domínio>` ou `gw.<domínio>`), sem `analytics`, `track`, `tracking`, `collect`, `umami`, `stats`, `metrics` nem `telemetry`, e o check do bloqueio deve rodar com ele (`pnpm --filter @stellytics/tracker check:adblock <host>`). Como o host é praticamente permanente, **decida o domínio e o dono final antes do primeiro deploy**: se a produção ainda não foi aplicada, registre o domínio já na conta do projeto ou da entidade que vai operar, e a opção A deixa de ser uma transferência e vira só uma troca de contato administrativo.

## O que o novo operador precisa ter e saber

**Ter (antes da Fase 1):**

- uma organização no GitHub com permissão para publicar releases, Actions ligado e GHCR habilitado;
- uma conta num provedor de VPS (Debian ou Ubuntu) e um armazenamento compatível com S3 para os backups, com as credenciais dele;
- o domínio, ou controle do DNS dele (opção A), e um e-mail para o Let's Encrypt;
- um provedor de SMTP com envio autenticado e o domínio do remetente configurado;
- um cofre de senhas de equipe (o `.env.production` e a `WALG_LIBSODIUM_KEY` ficam lá, **fora da VPS e do repositório**; sem a chave, nenhum backup é restaurável);
- pelo menos **duas pessoas** com acesso administrativo a tudo acima (uma pessoa só é o risco que esta transferência existe para tirar);
- as ferramentas de `docs/deploy.md` ("O que você precisa"): `git`, `ssh`, `openssl`, Docker, `jq`, Node 24 e pnpm 10.34.5.

**Saber (leia na ordem):**

1. [`docs/arquitetura.md`](arquitetura.md) e os ADRs [0001](adr/0001-ferramenta-base.md), [0002](adr/0002-arquitetura-e-stack.md), [0003](adr/0003-isolamento-no-portal.md) (isolamento entre tenants: nunca enfraqueça), [0005](adr/0005-monitoramento-externo.md), [0006](adr/0006-api-de-leitura-do-scf.md), [0007](adr/0007-cadastro-com-aprovacao.md) e [0016](adr/0016-producao-em-vps.md);
2. [`docs/deploy.md`](deploy.md): do zero à produção, atualizar, trocar segredo, restaurar;
3. os [runbooks](runbooks/README.md): incidentes, backup e restauração, rotação de segredos, atualização do Umami, vulnerabilidades. Todos têm a ressalva de que **nunca foram exercitados numa produção real**: o novo operador é quem vai corrigi-los na primeira vez;
4. [`docs/privacidade.md`](privacidade.md) e [`docs/umami.md`](umami.md): o IP completo nunca é persistido; o Umami nunca é exposto; qualquer patch no Umami fica documentado;
5. as restrições do `CLAUDE.md` ("Restrições que não são óbvias"): Umami fixado, licenças aprovadas pela OSI, o `tenant.id` vem sempre da chave de ingestão, script imutável por versão.

**Pendências conhecidas que o novo operador herda** (`docs/deploy.md`, "O que o guia ainda não cobre"): o coletor de API e o `rollup` ainda **não estão em produção**; a API de leitura do SCF não tem limite por IP no Caddy; é uma VPS só, sem alta disponibilidade; a restauração contra o bucket real nunca foi ensaiada.

## Ordem e janela de manutenção

Datas relativas ao dia da janela (`T`). Quem faz cada passo é o novo operador, **com o antigo ao lado**; a ideia é que na janela o antigo só execute os passos da origem.

### Fase 0: decisões e contratos (T-30 a T-14)

1. Decidir domínio e dono (opção A, B ou C acima) e o host neutro; rodar o check de ad blockers com o host.
2. Definir a entidade legal operadora, o DPA com os tenants e o aviso de privacidade (`docs/privacidade.md`).
3. **Avisar os tenants** ([Comunicação](#comunicação-aos-tenants)): data da janela, o que não muda e o que acontece com os dados no intervalo.
4. O novo operador cria as contas da seção anterior e lê a documentação.

### Fase 1: repositório e imagens (T-14)

Antes de tocar nos dados, porque o destino sobe a partir do repositório novo (do checkout ou das imagens da release dele).

1. Transferir o repositório; reativar relato privado de vulnerabilidade; instalar o Renovate; ligar o Actions.
2. **O novo operador publica uma release** (`vX.Y.Z`) no repositório novo, acompanha o `release.yml` até o fim e, se for usar as imagens da release em vez de construir do checkout, deixa os pacotes públicos. Isso já é o primeiro teste de que ele consegue publicar sozinho.
3. Conferir a assinatura com a identidade nova (à mão: o deploy não faz isso sozinho):

   ```bash
   cosign verify ghcr.io/<org-nova>/stellytics/portal@sha256:<digest> \
     --certificate-identity-regexp '^https://github.com/<org-nova>/stellytics/\.github/workflows/release\.yml@refs/tags/v' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

4. Conferir que o script publicado é o mesmo que os tenants usam: os arquivos `v1.0.0`, `v1.1.0` e `v1.2.0` da imagem do gateway novo têm de bater com o hash de `packages/tracker/published/sri.json` (`curl -fsS https://<host>/s/v1.2.0/n.js | openssl dgst -sha384 -binary | openssl base64 -A`, prefixado por `sha384-`). Os arquivos publicados são imutáveis: se o hash mudar, o SRI dos sites dos tenants quebra e o script deixa de carregar.
5. Se for usar as imagens da release, pôr os digests novos em `PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE` e `ROLLUP_IMAGE` no `.env.production` novo; senão, o `deploy.sh` constrói do checkout do repositório novo.

### Fase 2: infraestrutura nova e ensaio (T-14 a T-1)

1. Na conta nova: prepare a VPS com `init.sh` e `deploy.sh` (`docs/deploy.md`), com DNS **de ensaio** em domínio do novo operador (o Caddy obtém o certificado após a virada do DNS), e o monitoramento. O DNS precisa apontar para a VPS nova e as portas 80/443 estar acessíveis para o Caddy emitir os certificados; para testar com os nomes definitivos, eles precisam apontar para a VPS nova durante o ensaio.
2. **Ensaio de migração**, para medir o tempo e conferir o procedimento com dados reais antes da janela: restaure o backup mais recente do operador antigo numa VPS descartável (`docs/deploy.md`, "Restore the database"; é também o primeiro ensaio de restauração que o `backup-e-restauracao.md` marca como "nunca realizado"), e rode nela e na VPS nova o procedimento da [Migração de dados](#migração-de-dados-testada) do começo ao fim. Anote o tempo.
3. **Baixe o TTL** dos registros do portal e da ingestão para 300 s pelo menos um TTL antigo antes da janela (T-2 se o TTL for 24 h).

### Fase 3: a janela (T)

Janela sugerida: o horário de menor tráfego dos sites dos tenants, **longe do backup base das 03:00 UTC** e do timer do operador antigo (desligue o timer antigo no passo 2). Tamanho: o dos tempos do ensaio, mais a propagação do DNS e a emissão do certificado. Com os volumes do teste local (pequenos, ver os tempos abaixo) o trabalho de dados leva segundos, mas **com dados reais o tempo não foi medido**; reserve uma folga.

**Decisão registrada: janela longa, ingestão parada do passo 1 à virada do DNS.** O gateway antigo é parado no passo 1 e o novo só atende depois da virada; tudo o que chegar no intervalo se perde. Escolhido pela simplicidade e porque o dump consistente exige o Umami parado. **Alternativa não testada:** virar o DNS **antes** do backup (o gateway novo, ainda sem sites, descarta com `204` do mesmo jeito, mas o intervalo de perda passa a ser só o tempo de dump, transferência e restore, e o tráfego já chega ao Caddy novo com certificado válido). Ela só vale se o gateway novo estiver saudável e a perda for aceita; não foi ensaiada.

Durante a janela, o portal fica fora do ar (ninguém entra nem cria nada) e **a ingestão web para: os eventos que chegarem entre a parada do gateway antigo e o gateway novo atender são descartados** (o `fetch` do script falha em silêncio) e **não são recuperados**. Os painéis terão um buraco desse tamanho. Avise isso aos tenants.

Na VPS **antiga**, como root, na pasta do checkout (atualizado para esta versão do repositório, que tem os scripts em `infra/scripts/`). Como nos runbooks, `docker compose -f prod.yaml` abaixo abrevia `docker compose --env-file .env.production -f infra/compose/prod.yaml`, e os scripts recebem o mesmo comando em `COMPOSE`:

1. `docker compose -f prod.yaml stop caddy portal ingest-web collector rollup umami` (a ingestão para aqui).
2. `systemctl stop stellytics-backup.timer`.
3. `COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' infra/scripts/db-export.sh /root/migracao`. Gera `stellytics.dump`, `umami.dump`, `fingerprint.txt` e `sha256sums` (permissão 600).
4. Copie a pasta para a VPS nova sem passar por disco intermediário, pela máquina de quem administra:

   ```bash
   ssh root@<vps-antiga> 'tar -C /root -cf - migracao' | ssh root@<vps-nova> 'tar -C /root -xf -'
   ```

Na VPS **nova**, como root, na pasta do checkout, com o Postgres no ar e os demais serviços parados:

5. Suba só o banco com `docker compose -f prod.yaml up -d --wait postgres` e rode `COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' infra/scripts/db-import.sh --yes /root/migracao`. **Antes de apagar qualquer coisa** ele confere que o `sha256sums` lista `stellytics.dump` e `umami.dump` e bate, que os dois dumps abrem (`pg_restore -l`), que **nenhum serviço além do Postgres está rodando** (ele não os para) e que o destino tem **0 tenants** (`--force-nonempty` só de propósito: sem isso, rodar o script na VPS de origem por engano apagaria a produção). Restaura em bancos temporários (`stellytics_new`, `umami_new`) e só então troca pelos de verdade, reaplica o `02-ingest-roles.sh` e compara a impressão digital com a da origem. Só imprime `OK` se for idêntica; qualquer diferença aborta e você **não sobe a aplicação**.
6. Depois do `OK`, `docker compose -f prod.yaml up -d --wait`.
7. **Troque a senha do `admin` do Umami** pelo túnel (`infra/scripts/admin-tunnel.sh <ip-da-vps-nova>`, `http://127.0.0.1:13001`): ela veio do banco e o operador antigo a conhece.
8. `systemctl start stellytics-backup` (o primeiro backup base da linha nova, no bucket novo) e confira com `backup-list`.
**Virada do DNS** (com o gateway novo já saudável por IP):

10. Aponte os quatro nomes (portal/alias, ingestão web e API; A e AAAA) para os IPs da VPS nova. Com TTL de 300 s a virada leva alguns minutos; o Caddy emite os certificados quando os nomes chegam à VPS nova.
11. Conferir de fora, com os comandos do passo 3 ("Check production") do `docs/deploy.md`; entrar no portal com uma conta de tenant e abrir o painel de um site; abrir `/operator`; instalar o script num site de teste e ver a visita no painel.
12. Se o portal receber 401 do Umami, gere a chave de serviço de novo (`docs/deploy.md`, passo 2, "First start") e atualize `UMAMI_API_KEY`.
13. **Só depois de validar** (passos 11 e 12), apague os **dumps** (`stellytics.dump`, `umami.dump`; contêm hashes de senha e sessões) da VPS nova e da antiga: `rm -f /root/migracao/*.dump`. Deixe o `fingerprint.txt` e o `sha256sums` até o fim do período de reversão. Até lá os dumps são a forma mais rápida de refazer a migração: guarde-os só se a decisão for explícita, e apague no fim.

### Fase 4: depois (T até T+30)

1. **Operadores do SCF:** o novo operador cria as contas dele (`operator:create` ou `operator:promote`, com `DATABASE_URL` pelo túnel) e rebaixa as antigas (`operator:demote`). Decide sobre as chaves de leitura do SCF (`/operator/api`): reemitir e revogar as antigas.
2. **Rotacione** o que o antigo operador conhecia e que migrou: a senha do Umami (já feita), `PORTAL_AUTH_SECRET` e `UMAMI_APP_SECRET` (derrubam sessões; avise), e as credenciais de SMTP se foram compartilhadas.
3. Monitorar: o monitoramento novo vendo a produção nova, `pg_stat_archiver`, `backup-list` com um backup por dia.
4. **Período de reversão: 30 dias** (proposta). O antigo mantém a infraestrutura **ligada, mas sem receber tráfego** (aplicação parada, DNS no novo), o bucket antigo e a chave antiga guardados.
5. Ao fim: o antigo apaga a VPS, o host de monitoramento, o bucket e as credenciais; **destrói a `WALG_LIBSODIUM_KEY` antiga** e o `.env.production` antigo; revoga os acessos que tinha (organização do GitHub, DNS, domínio).

## Comunicação aos tenants

A ingestão **não pode parar de forma permanente**: sites de terceiros têm o script instalado e não vão mudar sozinhos.

| Quando | O que dizer |
|---|---|
| T-30 | Quem passa a operar, a data e o horário da janela, a duração esperada (o tempo do ensaio) e o que acontece: portal indisponível e **eventos do intervalo não são recuperados** |
| T-30 | **O que não muda:** o host do script e o `src` das páginas (opção A), as versões `v1.x` do script, as chaves de ingestão `ntf_...`, as contas e os projetos |
| T-30 | **O que muda:** quem é o operador, a entidade legal e o aviso de privacidade (`docs/privacidade.md`); os tenants precisam ser informados e, se a lei pedir, concordar com o novo DPA |
| T-1 | Lembrete |
| T | Início e fim da janela (um canal que não dependa do portal) |
| T+1 | Portal de volta; se o domínio do portal mudou (opção C), quem estava logado entra de novo |
| Opção C apenas | Instrução para trocar o host do script em cada site, o prazo, e a garantia de que o host antigo segue atendendo até o prazo acabar. Sem o prazo cumprido, **não** desligue o host antigo |

Decisão de host neutro: se a opção A for possível, os tenants não fazem nada. Se for preciso mudar de host, o texto acima já é a comunicação, e o novo host deve ser um nome neutro (seção anterior).

## Critérios de aceite da transferência

A transferência **só conta como concluída quando o novo operador roda o sistema sozinho**, sem o operador antigo conectado a nada. A #54 fecha com **todos** os itens abaixo, cada um com data e quem fez:

1. Plano aprovado pelas duas partes (este documento, com as decisões da Fase 0 registradas, e um ADR novo se o domínio mudar).
2. Repositório, Renovate e GHCR na organização nova; **uma release feita por ele**, com imagens assinadas na identidade nova, e a produção implantada a partir do repositório novo.
3. Produção numa VPS e num bucket **dele**, com os segredos dele (nenhum compartilhado com o antigo, salvo os de ligação listados acima, já rotacionados).
4. Migração de dados concluída com a impressão digital idêntica (`db-import.sh` terminou com `OK`) e a conferência do passo 11 da janela.
5. Ingestão chegando: uma visita de um site real dos tenants aparece no painel **depois de 7 dias**, e nenhum tenant relatou perda.
6. Backups diários dele no bucket dele (`backup-list`) e **um ensaio de restauração a partir dele**, numa VPS descartável, com a data registrada em `backup-e-restauracao.md`.
7. Monitoramento dele alertando por e-mail (alerta de teste recebido) e o sinal de vida configurado.
8. Ele executou sozinho, sem ajuda: uma atualização da aplicação (PR do Renovate ou release própria, `docs/deploy.md`, "Atualizar a aplicação"), uma rotação de segredo (`rotacao-de-segredos.md`), a criação e o rebaixamento de um operador e a revogação de uma chave de ingestão de teste.
9. O operador antigo não tem mais acesso a nada (lista conferida: GitHub, provedor da VPS, DNS e domínio, SMTP, cofre, VPS, bucket) e destruiu a chave de cifra antiga e os dumps.
10. Documentação atualizada: imagens, contatos e links do repositório; o `CLAUDE.md` e o `docs/andamento.md` registram o novo operador.

## Plano de reversão

Até o fim do período de reversão (30 dias) o antigo operador mantém tudo o que precisa para voltar.

| Em que ponto | Como voltar |
|---|---|
| **Antes da virada do DNS** (passos 1 a 8 da janela) | Abortar é seguro: na VPS antiga, `docker compose -f prod.yaml up -d --wait` e `systemctl start stellytics-backup.timer`. A ingestão volta; os eventos do intervalo da janela já se perderam. Os dados da VPS antiga não foram alterados (o `db-export.sh` só lê) |
| **Depois da virada** | Aponte o DNS de volta para o IP antigo (TTL de 300 s) e suba a pilha antiga (comando acima). **O que o novo operador gravou desde a virada se perde**, a menos que seja trazido de volta: pare a aplicação nova, rode `db-export.sh` nela e `db-import.sh --yes` na antiga. Os scripts são os mesmos, **mas essa direção não foi testada** |
| **Imagens** | A pilha antiga volta com o checkout e o `.env.production` do operador antigo; não misture os dois `.env.production` |
| **Repositório** | A transferência de volta é outra transferência no GitHub; não é preciso reverter para voltar a operar |
| **Domínio** | Na opção A, a devolução depende de o operador novo cooperar: registre no acordo da Fase 0 quem decide e em quanto tempo |

Se o problema aparecer depois dos 30 dias, a reversão deixa de ser um plano e vira restauração de backup (`docs/deploy.md`, "Restore the database").

## Migração de dados (testada)

Procedimento para mover os bancos `stellytics` e `umami` de uma pilha para outra, com **três scripts** e um teste que roda os dois caminhos de ponta a ponta.

| Arquivo | Papel |
|---|---|
| [`infra/scripts/db-export.sh`](../infra/scripts/db-export.sh) | Na origem, com **tudo parado exceto o Postgres**: `pg_dump -Fc` de cada banco, confere que o arquivo abre, grava a impressão digital e o `sha256sums` |
| [`infra/scripts/db-import.sh`](../infra/scripts/db-import.sh) | No destino: confere o `sha256sums`, exige a aplicação parada e o destino sem tenants, restaura em bancos temporários, troca pelos de verdade, reaplica o `02-ingest-roles.sh` e compara a impressão digital. **Destrutivo** (`--yes`) |
| [`infra/scripts/db-fingerprint.sh`](../infra/scripts/db-fingerprint.sh) | Imprime, sem dados de ninguém e sem senhas, as linhas e um checksum de **cada tabela** (partições inclusas), as sequências, o hash do esquema (`pg_dump --schema-only`), as extensões, os papéis, as filiações e as ACLs dos bancos e as permissões de `stellytics_ingest` e `stellytics_collector` |
| [`infra/compose/test/data-migration-test.sh`](../infra/compose/test/data-migration-test.sh) | O teste: sobe origem e destinos com as imagens de produção (Compose de produção por cima de `prod.yaml`), grava dados, migra e confere |

Os scripts já estão no checkout da VPS (`infra/scripts/`).

### Dois caminhos

- **A. Lógico (`pg_dump`/`pg_restore`), o recomendado.** Funciona entre contas, não depende da chave de cifra antiga, deixa o destino com **senhas, chave de backup e bucket próprios** e não carrega os papéis do banco da origem (o destino cria os dele). O custo é a janela proporcional ao tamanho dos dados.
- **B. Físico (WAL-G).** Copia o bucket de backup para o do novo operador e restaura com `stellytics-restore` (`docs/deploy.md`, "Restore the database"). Serve se o volume de dados for tão grande que o dump não caiba na janela. Exige a **chave de cifra antiga** nas mãos do novo operador e **traz os papéis da origem, com as senhas da origem** (achado abaixo). Um backup base final mais o WAL arquivado fecham a diferença até a parada.

**Passos do caminho B** (os que o teste executou, na ordem), com a pilha de destino **sem o Postgres iniciado** e o `.env` do destino com a `WALG_LIBSODIUM_KEY` da origem e o `WALG_S3_PREFIX` do bucket novo:

1. Origem, janela aberta: `docker compose -f prod.yaml stop caddy portal ingest-web collector rollup umami`; `docker compose -f prod.yaml exec -T -u postgres postgres stellytics-backup`; troque o segmento de WAL (`select pg_switch_wal()`) e espere o `pg_stat_archiver` arquivá-lo.
2. Copie o prefixo do bucket antigo para o novo (o teste usou `rclone sync --checksum` entre dois endpoints S3 e conferiu a contagem e o tamanho dos objetos).
3. Destino: `docs/deploy.md`, "Restore the database", com a pasta de dados vazia (`stellytics-restore LATEST`), e suba o Postgres.
4. Alinhe as senhas dos papéis ao `.env` do destino (achado 4 abaixo) e reaplique o `02-ingest-roles.sh`.
5. Compare `db-fingerprint.sh` com o da origem e suba a aplicação.

### O que o teste fez

Rodado em 15/11/2026, na máquina de desenvolvimento, com o Compose de produção e as imagens reais: Postgres 17.11 com WAL-G 3.0.9, Umami 3.4.1 (digest do `prod.yaml`) e o portal construído desta árvore (migrações 0000 a 0007, as de agora). O Caddy e o gateway não entram (o gateway é só leitor de `ingest_site`; ver "O que não foi testado").

Pilha de **origem** com dados de verdade:

- dois usuários criados pela API de cadastro do portal (senha com o hash do Better Auth), um deles operador, e uma **sessão** da Alice;
- 3 tenants (`active`, `removed`, `pending`), 3 sites, 3 serviços de API (um arquivado), 4 chaves de ingestão (ativa, revogada, de serviço arquivado, de tenant removido; **só a ativa** aparece em `ingest_key_active`);
- **34.567 linhas** em `api_metric_1m` (4 dias de pontos de 1 minuto em 3 rotas e 2 status), mais 60 pontos de 40 dias atrás (que caem na partição `default`, porque só o mês corrente e os dois seguintes têm partição) e 1 ponto no mês seguinte; `api_metric_maintain` de verdade gerou **576 linhas em 1h e 30 em 1d**; 3 linhas no `audit_log`;
- no Umami: um site criado pela API dele e **60 eventos** enviados pelo `/api/send`, como o gateway faz (18 visitantes, 18 sessões). O banco `umami` tem 26 migrações do Prisma, a extensão `pgcrypto` e 27 tabelas.

Cada pilha de **destino** sobe vazia, com o Compose de produção, **senhas e chave de backup diferentes** (as secrets de sessão do portal e do Umami são as mesmas, de propósito).

Caminho **A**, como na janela: pilha de destino completa e vazia no ar (o portal migrou o banco vazio e o Umami criou o esquema dele), `db-export.sh` na origem, `db-import.sh --yes` no destino, depois a aplicação sobe sobre os dados migrados.

Caminho **B**: backup base e WAL da origem no S3 local (SeaweedFS, o mesmo do job `infra` do CI), **cópia do bucket para o bucket de outro S3** (rclone, com credenciais diferentes; 22 objetos, 16,98 MB, mesma contagem e tamanho nos dois lados), `stellytics-restore LATEST` em pasta vazia, subida do Postgres, ajuste das senhas, aplicação por cima.

### Resultados

Nos dois caminhos, o `db-fingerprint.sh` do destino ficou **idêntico ao da origem**: **27 tabelas por banco com a mesma contagem de linhas e o mesmo checksum** (inclusive as 15 tabelas de métricas: a pai, a `default` com as 60 linhas e as partições dos meses, em cada uma das três granularidades), a sequência do Drizzle (`__drizzle_migrations_id_seq` em 8), o mesmo hash de esquema (10 funções, 4 gatilhos, 2 visões, 36 vínculos de herança entre partições, tabelas e índices, GRANTs e donos), as mesmas extensões, os mesmos papéis e as mesmas ACLs. A impressão digital foi checada para cobrir **todas** as tabelas (o teste compara com `pg_class`).

Depois, com a aplicação rodando no destino:

- o **login com a senha da origem funciona** e a **sessão criada na origem continua válida** (mesmo `portal_auth_secret`);
- o Umami (sem fork) abriu o banco migrado e devolveu **as mesmas estatísticas** (`/stats`: 60 page views, 18 visitantes), e o login `admin` migrou junto;
- a **chave de ingestão original** (SHA-256 de 32 bytes) continua aceita por `ingest_key_active`, e as outras três continuam fora dela;
- o `audit_log` **continua só de inserção**: `UPDATE`, `DELETE` e `TRUNCATE` são recusados pelos gatilhos e o `INSERT` passa;
- `stellytics_ingest` e `stellytics_collector` **entram pela rede com as senhas novas** e leem só `ingest_site` e `ingest_key_active`; `stellytics_ingest` **não** lê `tenant`; `stellytics_collector` insere em `api_metric_1m`;
- `api_metric_ensure_partitions(2)` roda, e as partições existem;
- o `db-import.sh` **recusa**, sem tocar nos bancos do destino (OIDs iguais antes e depois), cada um destes casos: aplicação rodando, dump adulterado, dump truncado com `sha256sums` regenerado, `sha256sums` sem os dumps, e a própria origem como destino (tem tenants).

**Tempos** (uma máquina de desenvolvimento, dados pequenos: `stellytics.dump` com 224 KB e `umami.dump` com 68 KB; **não extrapole para dados reais**):

| Passo | Tempo |
|---|---|
| Destino vazio no ar (Postgres, portal e Umami subindo e migrando) | 32 s |
| A: `db-export.sh` (dois dumps + impressão digital) | 2 a 6 s |
| A: `db-import.sh` (confere, recria, restaura, impressão digital) | 2 a 7 s |
| A: aplicação no ar sobre os dados migrados | 17 s |
| B: backup base final e último WAL na origem | 4 a 8 s (a primeira vez, 63 s) |
| B: cópia do bucket entre dois S3 (17 MB) | 6 a 13 s |
| B: `stellytics-restore LATEST` e o Postgres aplicando o WAL e abrindo | 1 s e 11 a 12 s |
| B: aplicação no ar sobre os dados restaurados | 18 a 23 s |

### O que deu errado, e o que mudou no procedimento

1. **O `pg_dump --schema-only` nunca dá o mesmo hash duas vezes.** O `pg_dump` 17 escreve uma linha `\restrict <token aleatório>` (e `\unrestrict`) em toda saída. A primeira comparação do esquema falhou nos dois bancos por causa **só** disso (conferido com `diff` dos dois esquemas). O `db-fingerprint.sh` agora tira essas linhas.
2. **A impressão digital só conferia a primeira tabela.** O `docker compose exec -T` lê a entrada padrão e, dentro de `while read`, engolia a lista de tabelas; o teste passou com o destino "idêntico" olhando uma tabela por banco. Corrigido (`< /dev/null`), e o teste agora **compara o número de tabelas da impressão digital com o de `pg_class`** para que isso não volte em silêncio. **Os resultados acima são da execução depois da correção.**
3. **A senha do banco não pode ser testada por dentro do contêiner do Postgres.** Na imagem oficial, o socket local e o `127.0.0.1` são `trust`: qualquer senha entra. A primeira versão do teste "provou" as senhas assim, sem provar nada. Agora o teste conecta **pela rede do Compose**, de um contêiner à parte (`pg_net`).
4. **Achado do caminho B: as senhas dos papéis vêm da origem.** O restore físico traz o catálogo inteiro, inclusive os hashes de senha de `postgres`, `stellytics`, `umami`, `stellytics_ingest` e `stellytics_collector`. Com o `.env` do destino (senhas diferentes), o teste confirmou que **`stellytics` não entra** com a senha do destino. O procedimento do caminho B ganhou o passo de alinhar: `ALTER ROLE postgres|stellytics|umami PASSWORD '<do .env>'` (lendo a senha sem eco, como em `rotacao-de-segredos.md`) e reaplicar o `02-ingest-roles.sh`. Foi o que o teste fez, e a impressão digital passou depois disso. Se o destino reutilizasse as mesmas senhas da origem, o passo não seria necessário; mas aí as senhas antigas ficariam com o novo operador.
5. **O que não vai no dump, por construção, e como o procedimento cobre:**
   - **papéis e senhas:** `pg_dump` não os leva; o destino os cria nos scripts de init (`01` e `02`) com as senhas dele;
   - **permissão de `CONNECT` nos bancos** (`stellytics_ingest` e `stellytics_collector`): é ACL do banco, não vai no dump e some no `DROP`/`CREATE DATABASE`; por isso o `db-import.sh` reaplica o `02-ingest-roles.sh` (idempotente) e a impressão digital compara a ACL do banco. Não foi observada a falha sem essa reaplicação; é por construção;
   - **extensões:** vão no dump (`pgcrypto` do Umami) e o restore as recria como superusuário (`postgres`); funcionou;
   - **sequências:** só a do Drizzle existe nos dois bancos (os IDs são `uuid`), e o valor migrou;
   - **o diário do Drizzle** (`drizzle.__drizzle_migrations`, 8 linhas) vem no dump do `stellytics`: o portal novo não reaplica migração (o log do portal diz só "migrações aplicadas" na subida);
   - **certificados TLS** (`/srv/stellytics/caddy`): não se migram; o Caddy no novo VPS emite certificados automaticamente após a virada do DNS;
   - **histórico de backup do WAL-G e dados do Prometheus:** não migram; o destino começa linhas novas (`systemctl start stellytics-backup` depois da migração).
6. **Versão do destino.** O `db-import.sh` confere a impressão digital **antes** de a aplicação subir, então ela só bate se o destino restaurou exatamente o que a origem tinha. Se as imagens do destino forem **mais novas** e trouxerem migração, o portal as aplica na subida (comportamento normal do `RUN_MIGRATIONS`; **não foi testado na migração**). Nunca suba uma versão **mais antiga** que a da origem sobre os dados: as migrações só andam para frente (`docs/deploy.md`, "Atualizar a aplicação").
7. **O destino precisa estar vazio de dados, não de estrutura.** Se o `deploy.sh` já subiu o portal e o Umami, eles criaram tabelas vazias, e o restore bateria nelas (não tentado). O `db-import.sh` por isso exige a aplicação parada, restaura em bancos temporários e troca pelos de verdade (é o caminho testado). Ele **recusa** um destino com tenants (a origem, por exemplo) sem `--force-nonempty`; com a opção, apaga esses dados: confira o host antes.
8. **Falhas e reexecução.** O `db-import.sh` pode ser rodado de novo. Uma falha **antes** da troca (soma que não bate, dump que não abre, restore que falha, aplicação rodando, destino não vazio) deixa o destino **como estava** (testado: os OIDs dos bancos não mudam). Uma falha **depois** da troca (impressão digital diferente) deixa o destino com os dados restaurados e **a aplicação parada**: investigue ou rode de novo; não suba a aplicação. Se o `db-import.sh` for interrompido à força (queda da máquina) no meio, podem sobrar `stellytics_new` ou `umami_new`, que a execução seguinte apaga.
9. **`sha256sums` prova integridade, não autenticidade.** Quem consegue alterar a pasta altera também a soma; a autenticidade vem do canal (ssh entre as duas VPS, pela máquina de quem administra). O `db-export.sh` recusa uma pasta de saída que não esteja vazia: depois de uma exportação interrompida, apague a pasta parcial (`rm -rf`) antes de repetir.

### Reexecutar o teste

Da raiz do repositório, com a imagem do portal construída e Docker com Compose v2:

```bash
docker compose build portal   # ou a imagem de uma release
PORTAL_IMAGE=stellytics-portal:dev infra/compose/test/data-migration-test.sh
```

Roda a origem e os dois destinos lado a lado (nomes de projeto `stellytics54-*`, portas no loopback `13541`–`13543`, `18333`–`18335` e `13641`–`13643`; troque com `PORT_BASE` e `S3_BASE`), derruba tudo e apaga os volumes no fim. `MODE=logical` ou `MODE=physical` roda só um caminho; `KEEP=1` não derruba. O teste usa imagens de contêiner baixadas na hora (`rclone/rclone`, `alpine`) e **não está no CI** (leva alguns minutos e precisa da imagem do portal): ligá-lo ao job `infra` é um próximo passo.

## O que não foi testado

O critério "procedimento de migração de dados testado" vale **só para o que está listado em "O que o teste fez"**. Não foi executado:

- **Transferência real de repositório, organização, pacotes do GHCR, Renovate, domínio, DNS, contas, SMTP e provedor da VPS.** Os comportamentos do GitHub descritos aqui (redirecionamento, o que a transferência leva e não leva, visibilidade dos pacotes novos) seguem a documentação dessas ferramentas e podem estar errados ou ter mudado; **confira ao fazer**.
- **`cosign verify` contra imagens reais com a identidade nova.** Ainda não existe release publicada em lugar nenhum.
- **`init.sh`, `deploy.sh` e a emissão do certificado** numa VPS real.
- **Restauração do WAL-G contra um bucket S3 real.** O caminho B usou S3 local (SeaweedFS).
- **Volume real de dados.** O Umami teve **60 eventos** e as métricas de API 34.567 linhas. Tempo de dump, de restore, de cópia e uso de disco com milhões de eventos **não foram medidos**, e o `db-fingerprint.sh` agrega o texto das linhas de cada tabela dentro do Postgres, o que pode ficar pesado em tabelas grandes (o hash é por linha, mas ele percorre tudo).
- **Mudar `portal_auth_secret` ou `umami_app_secret` no destino.** O teste usou os mesmos valores (a sessão antiga continuar válida depende disso). O efeito de trocá-los, inclusive nos IDs de visitante do Umami, **não foi medido**.
- **A chave de API do Umami** (`umami_api_key`): o teste não criou a conta de serviço, então não se sabe se a chave sobrevive à migração.
- **Caddy no host e os serviços gateway `ingest-web` e coletor/`rollup`** como serviços. O gateway não subiu; o que ele lê (a visão `ingest_site`, como `stellytics_ingest`) foi conferido por SQL. O coletor e o `rollup` não estão em produção; as tabelas e funções deles migraram (partições, `api_metric_ensure_partitions`, GRANT de `stellytics_collector`).
- **A reversão** (`db-export.sh` na pilha nova e `db-import.sh` na antiga), a opção C do domínio e os aliases Caddy que ela exige.
- **Versão maior do Postgres** entre origem e destino (o teste usa a 17.11 nos dois lados).
- **O tempo e as perdas reais da janela**, e a propagação do DNS.
- **A comunicação aos tenants** e os aspectos jurídicos (DPA, entidade legal, suboperadores): é texto proposto, não validado.
