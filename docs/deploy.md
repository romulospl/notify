# Deploy da produção

Há dois caminhos: uma instalação mínima numa VPS existente, descrita abaixo, ou a infraestrutura gerenciada na Hetzner com OpenTofu e Ansible ([#14](https://github.com/romulospl/stellytics/issues/14)), detalhada nas seções seguintes.

## Caminho mínimo: VPS existente

Este caminho serve para uma VPS Debian/Ubuntu. Não exige conta na Hetzner nem armazenamento S3: o Postgres e os certificados ficam em volumes Docker locais. **Não há backup externo automático**; se a VPS ou o disco forem perdidos, os dados também podem ser perdidos.

Pré-requisitos: acesso root à VPS; quatro nomes DNS apontando para ela (`PORTAL_HOST`, `PORTAL_ALIAS_HOST`, `INGEST_HOST` e `API_HOST`); portas 80 e 443 liberadas; e um SMTP real para confirmação de cadastro e redefinição de senha.

Na VPS, dentro do clone do repositório:

```bash
cd /var/www/html/stellytics
sudo ./init.sh
sudo nano .env.production
sudo ./deploy.sh
```

O `init.sh` instala Docker/Compose e gera senhas aleatórias no `.env.production` com permissão `0600`. Preencha nele os quatro domínios, `ACME_EMAIL`, `SMTP_URL` e `MAIL_FROM`; não troque as senhas geradas. Codifique caracteres especiais da senha SMTP como URL encoding.

O `deploy.sh` constrói as imagens do portal, gateway, coletor e rollup no servidor. Postgres, Umami e Caddy usam imagens fixadas. Só o Caddy publica portas; Postgres fica acessível apenas pelo loopback e Umami só na rede interna. O comando `docker compose down` preserva os volumes; **não use `down -v`**, que apaga o banco e o estado TLS.

Confira a pilha na VPS:

```bash
cd /var/www/html/stellytics
sudo docker compose --env-file .env.production -f infra/compose/prod-vps.yaml ps
```

Na primeira subida, troque a senha inicial do Umami (`admin`/`umami`) pelo túnel `infra/scripts/admin-tunnel.sh <IP-da-VPS>`. Para o portal criar sites no Umami, gere a chave de conta de serviço num clone com Node 24, salve em `UMAMI_API_KEY` no `.env.production` e rode `sudo ./deploy.sh` novamente:

```bash
read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
UMAMI_URL=http://127.0.0.1:13001 node apps/portal/scripts/umami-service-account.mjs
```

O script imprime a chave uma vez. Guarde-a no `.env.production`, sem compartilhá-la.

## Caminho gerenciado: Hetzner

As decisões deste caminho estão no [ADR 0004](adr/0004-hospedagem-e-backup.md); os arquivos, em [`infra/`](../infra/README.md).

> **Escopo.** Este guia sobe toda a infraestrutura da aplicação em [`infra/compose/prod.yaml`](../infra/compose/prod.yaml): Caddy, portal, gateway de ingestão web, coletor de API, job de consolidação, Umami e Postgres com backup, mais o monitoramento externo. O Caddy termina TLS automaticamente e encaminha os hosts pela rede Docker. O coletor e o job de consolidação entraram em 16/11/2026 ([ADR 0012](adr/0012-ingestao-de-api-pelo-caddy.md)). **A [#42](https://github.com/romulospl/stellytics/issues/42) ainda não está cumprida:** o critério de aceite (alguém de fora faz o deploy seguindo só o guia) só será cumprido quando alguém de fora seguir o guia numa conta real.

## Visão geral

```mermaid
flowchart LR
  internet((Internet)) -->|80, 443| caddy[Caddy em Docker]
  subgraph vm["VM na Hetzner (nbg1, Alemanha)"]
    caddy --> portal[Portal]
    caddy --> gw[Gateway ingest-web]
    caddy --> collector[Coletor OTLP]
    portal --> umami[Umami]
    gw --> umami
    portal --> pg[(Postgres + WAL-G)]
    gw --> pg
    umami --> pg
  end
  pg -->|WAL contínuo e backup diário, cifrados| s3[(Object Storage nbg1)]
```

- Todos os serviços da aplicação, inclusive o proxy, rodam no Docker Compose. Só o Caddy publica 80/443; Postgres publica apenas no loopback para o túnel SSH e os demais serviços ficam na rede interna.
- Os dados do Postgres e o estado/certificados TLS do Caddy ficam no volume da Hetzner em `/srv/stellytics`.
- Caddy não grava access logs; erros são enviados ao log do contêiner sem cabeçalhos ou URLs sensíveis.

## Onde ficam os dados (data residency)

| O quê | Onde |
|---|---|
| VM e volume com o Postgres (bancos `stellytics` e `umami`) | Hetzner, Nuremberg (`nbg1`), Alemanha |
| Backups do Postgres (WAL e backups base), cifrados no cliente | Hetzner Object Storage, Nuremberg (`nbg1`), Alemanha |

O local é a variável `location` do OpenTofu. Se mudar, mude também `walg_s3_endpoint` e `walg_s3_region` no Ansible.

## O que você precisa

**Contas e serviços:**

| O quê | Para quê |
|---|---|
| Projeto na Hetzner Cloud, com o Object Storage habilitado | VMs, volume, firewall e o bucket do backup |
| Um domínio com controle do DNS (qualquer provedor) | Três nomes: portal, ingestão web e ingestão de API (passo 2) |
| Um provedor de SMTP (envio autenticado) | Confirmação de e-mail no cadastro e recuperação de senha do portal. **Sem ele ninguém consegue se cadastrar**, porque o e-mail confirmado é obrigatório. Formato da URL: `smtps://usuario:senha@host:465` |
| Um e-mail para o Let's Encrypt (`acme_email`) | Avisos de certificado TLS automático do Caddy |
| Uma conta no GitHub com permissão para publicar releases do repositório (ou o seu fork) | Gerar as imagens assinadas (passo 3) |
| Opcional: um serviço de sinal de vida (healthchecks.io ou similar) | Avisa se a própria VM de monitoramento cair |

**Ferramentas na sua máquina:**

- `git`, `ssh` e `openssl`; opcionalmente a CLI `hcloud` (para `hcloud server-type list`; sem ela, veja os tipos no console da Hetzner);
- OpenTofu 1.13.2 ou mais novo (ou o contêiner `ghcr.io/opentofu/opentofu:1.13.2`) e Ansible (ansible-core 2.21; o deploy usa só `ansible.builtin`, sem coleções extras);
- Docker com buildx e `jq`, para ler os digests das imagens (ou pegue os digests na página do pacote no GitHub);
- Node 24 ou mais novo e pnpm 10.34.5 (`corepack enable`), para os comandos de administração do passo 5.

Clone o repositório e instale as dependências. Todos os comandos abaixo partem da raiz do clone:

```bash
git clone https://github.com/romulospl/stellytics.git && cd stellytics
corepack enable && pnpm install
```

Para o caminho gerenciado na Hetzner, instale OpenTofu e `ansible-core` conforme
a lista acima. Os scripts `init.sh` e `deploy.sh` são do caminho mínimo de VPS;
eles instalam Docker localmente e não substituem os playbooks Ansible desta seção.

**Segredos** (nunca no repositório):

| Segredo | Onde é usado | Como obter |
|---|---|---|
| `HCLOUD_TOKEN` | OpenTofu | Console da Hetzner → projeto → Security → API tokens (leitura e escrita) |
| `TF_VAR_object_storage_access_key` e `TF_VAR_object_storage_secret_key` | OpenTofu (cria o bucket) e Ansible (`walg_s3_access_key` e `walg_s3_secret_key`) | Console da Hetzner → projeto → Object Storage → credenciais S3 |
| `secrets.yml` | Ansible | Copie `infra/ansible/secrets.example.yml` e preencha (veja abaixo) |

No `secrets.yml`, todos estes campos são **obrigatórios** (o playbook para se algum estiver vazio): `postgres_password`, `umami_db_password`, `stellytics_db_password`, `stellytics_ingest_db_password`, `stellytics_collector_db_password`, `umami_app_secret`, `portal_auth_secret`, `ingest_proof_secret`, `smtp_url`, `walg_s3_access_key`, `walg_s3_secret_key` e `walg_libsodium_key`. Gere cada senha ou chave com `openssl rand -hex 32` (64 caracteres; o `ingest_proof_secret` exige pelo menos 32, e a `walg_libsodium_key` exatamente 64 hexadecimais). O `umami_api_key` começa vazio e só existe depois do passo 5. O `secrets.yml` e o `inventory/production.yml` estão no `.gitignore`.

A chave `walg_libsodium_key` cifra os backups: **sem ela, nenhum backup pode ser restaurado**. Guarde uma cópia no cofre de senhas do time, fora da VM.

**Se você faz um fork** (em vez de usar as imagens do `romulospl/stellytics`): troque `ghcr.io/romulospl/stellytics/...` pelas suas imagens e o `cosign_identity_regexp` pelo caminho do `release.yml` do seu fork, em `group_vars/all.yml`. O playbook recusa imagens cuja assinatura não bata com essa identidade.

## 1. Provisionar a infraestrutura (OpenTofu)

1. Copie `infra/opentofu/production.tfvars` para `infra/opentofu/production.secret.tfvars` (esse nome está no `.gitignore`) e troque todos os valores `CONFIRA`: `server_type` e `monitor_server_type` (confira com `hcloud server-type list`; escolha tipos com a mesma arquitetura, x86 ou Arm, das imagens publicadas, que são `linux/amd64`), `backup_bucket` (nome único em toda a Hetzner), `admin_ssh_public_key` e `admin_cidrs` (os IPs de onde você administra, nunca `0.0.0.0/0`). Se o seu IP mudar, atualize `admin_cidrs` e aplique de novo, ou o SSH fica fechado.
2. Rode (com o `-var-file` que você criou):

   ```bash
   export HCLOUD_TOKEN=...
   export TF_VAR_object_storage_access_key=...
   export TF_VAR_object_storage_secret_key=...
   tofu -chdir=infra/opentofu init
   tofu -chdir=infra/opentofu apply -var-file=production.secret.tfvars
   tofu -chdir=infra/opentofu output
   ```

   As saídas trazem os IPs da VM (`server_ipv4`, `server_ipv6`) e da VM de monitoramento (`monitor_ipv4`), o dispositivo do volume (`data_volume_device`) e o endpoint e o prefixo do backup (`backup_s3_endpoint`, `backup_s3_prefix`). Guarde-as: os passos 2 e 4 usam todas.
3. Espere um ou dois minutos: o cloud-init atualiza a VM na primeira subida. Confira que o SSH entra: `ssh root@<server_ipv4> true` (aceite a chave do host; o Ansible recusa hosts desconhecidos, `host_key_checking = True`).

A VM, o volume e o bucket têm proteção contra remoção (`delete_protection`, `prevent_destroy`): o `tofu destroy` falha de propósito.

## 2. DNS

Crie registros A (e AAAA, com o IPv6) apontando para a VM:

- `stellytics.xyz` (redireciona para o portal);
- `app.stellytics.xyz` (portal);
- `e.stellytics.xyz` (ingestão web; não contém termos bloqueados por ad blockers);
- `otlp.stellytics.xyz` (OTLP/HTTP e gRPC na 443).

Use os IPs `server_ipv4` (A) e `server_ipv6` (AAAA). O Caddy no Compose solicita e renova certificados automaticamente depois que os quatro nomes resolverem para a VPS e as portas 80/443 estiverem liberadas. Não é necessário instalar proxy ou cliente ACME no host.

## 3. Publicar as imagens

O deploy só aceita imagens publicadas pelo workflow de release, assinadas com cosign e referenciadas por digest.

1. Publique uma release no GitHub (`vX.Y.Z`; o repositório ainda não tem nenhuma). O workflow `release.yml` gera o SBOM e publica no GHCR uma imagem para cada `Dockerfile` de `apps/*` e `services/*`, assinada com cosign. O deploy usa as quatro: `ghcr.io/romulospl/stellytics/portal`, `ingest-web`, `collector` e `rollup`, com a tag **sem o `v`** (`X.Y.Z`); cada uma vai por digest em `portal_image`, `ingest_web_image`, `collector_image` e `rollup_image`. Acompanhe o workflow em Actions até todos os jobs ficarem verdes.
2. **Deixe os pacotes públicos.** Pacotes novos do GHCR nascem privados, e a VM baixa as imagens e confere a assinatura sem `docker login`. Em GitHub → Packages → cada pacote (`stellytics/portal`, `stellytics/ingest-web`) → Package settings → Change visibility → Public. Sem isso, o passo 4 falha em `cosign verify` ou no `docker compose up` com `unauthorized`.
3. Pegue os digests:

   ```bash
   docker buildx imagetools inspect ghcr.io/romulospl/stellytics/portal:X.Y.Z --format '{{json .Manifest}}' | jq -r .digest
   docker buildx imagetools inspect ghcr.io/romulospl/stellytics/ingest-web:X.Y.Z --format '{{json .Manifest}}' | jq -r .digest
   ```

## 4. Deploy (Ansible)

1. Em `infra/ansible/`:
   - copie `inventory/production.example.yml` para `inventory/production.yml` e preencha com as saídas do OpenTofu (`server_ipv4` e `data_volume_device` no host `stellytics`; `monitor_ipv4` no host `monitor`, usado só no passo de monitoramento);
   - copie `secrets.example.yml` para `secrets.yml` e preencha.
2. Em `group_vars/all.yml`, preencha:
   - os hosts (`portal_host`, `portal_alias_host`, `ingest_host`, `api_host`), `acme_email` e `mail_from` (remetente dos e-mails do portal; o domínio dele precisa estar autorizado no seu SMTP);
   - `signup_approval` (`false` por padrão): com `true`, todo projeto novo fica `pending` até um operador aprovar em `/operator/approvals` ([ADR 0007](adr/0007-cadastro-com-aprovacao.md)). Ligar ou desligar vale só para cadastros novos e exige reaplicar o playbook (reinicia o portal); projetos já pendentes continuam na fila;
   - `portal_image`, `ingest_web_image`, `collector_image` e `rollup_image`, no formato `ghcr.io/romulospl/stellytics/portal@sha256:<digest>` (o playbook recusa imagem sem digest);
   - `walg_s3_prefix`, com a saída `backup_s3_prefix`. O `walg_s3_endpoint` e o `walg_s3_region` já vêm certos para `nbg1`.
3. Confira a conexão e rode, de `infra/ansible/`:

   ```bash
   ansible stellytics -m ping
   ```

   ```bash
   ansible-playbook site.yml -e @secrets.yml
   ```

Na primeira vez leva alguns minutos (atualizações, Docker, build da imagem do Postgres com WAL-G). O playbook prepara a VM e sobe a aplicação:

- atualiza a VM e liga as atualizações automáticas de segurança;
- instala Docker (com a chave do repositório conferida) e cosign;
- monta o volume;
- copia o Compose, o Caddyfile e o `.env` (permissão 600) para `/opt/stellytics`;
- confere a assinatura das imagens;
- sobe a pilha (as migrações do portal rodam nessa subida) e liga o timer do backup diário.

Nessa primeira subida, o `UMAMI_API_KEY` está vazio: o portal funciona (login, cadastro), mas ainda não cria sites no Umami. O passo 5 resolve.

Ele pode rodar de novo quantas vezes for preciso; sem mudança, não altera nada.

## Atualizar uma produção `notify` existente

O primeiro `ansible-playbook site.yml -e @secrets.yml` desta versão faz a
troca de marca numa janela de manutenção. Antes de executá-lo:

1. renomeie no `secrets.yml` as chaves `notify_db_password`,
   `notify_ingest_db_password` e `notify_collector_db_password` para as
   equivalentes `stellytics_*`, preservando os valores se não pretende trocar
   as senhas nessa janela;
2. atualize o grupo do host no inventário de `notify` para `stellytics`;
3. rode `tofu plan` e confira que os recursos `hcloud_server.notify` e
   `hcloud_firewall.notify` aparecem como movidos, sem recriação da VM.

O playbook para a pilha `notify`, desliga o timer de backup antigo, desmonta o
volume de `/srv/notify`, monta-o em `/srv/stellytics`, renomeia o banco e os
papéis PostgreSQL e só então inicia os serviços novos. Ele interrompe o
tráfego durante essa etapa. Se os dois bancos ou pares de papéis já existirem,
ele para sem escolher qual conjunto de dados preservar.

## 5. Primeira subida (caminho gerenciado na Hetzner)

1. **Túnel de administração** (deixe aberto num terminal):

   ```bash
   infra/scripts/admin-tunnel.sh <ip-da-vm>
   ```

   Postgres em `127.0.0.1:15432`, Umami em `http://127.0.0.1:13001`. Nada disso fica exposto na internet.
2. **Troque a senha do administrador do Umami.** Ele nasce com `admin`/`umami` (alcançável só pelo túnel). Entre em `http://127.0.0.1:13001` pelo túnel e troque, antes de qualquer outro passo.
3. **Conta de serviço do Umami** (o portal usa a chave dela), da raiz do clone e com o túnel aberto:

   ```bash
   read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD   # bash ou zsh; a senha nova do passo 2
   UMAMI_URL=http://127.0.0.1:13001 pnpm --filter @stellytics/portal umami:service-account
   ```

   A chave impressa na saída padrão vai em `umami_api_key` no `secrets.yml`. Rode o playbook de novo (`ansible-playbook site.yml -e @secrets.yml`): ele recria só o portal com a chave.
4. **Primeiro operador do SCF** (conta com visão global; nasce com e-mail já confirmado), também com o túnel aberto:

   ```bash
   read -rs OPERATOR_PASSWORD && export OPERATOR_PASSWORD   # bash ou zsh; mínimo de 12 caracteres
   DATABASE_URL='postgresql://stellytics:<stellytics_db_password>@127.0.0.1:15432/stellytics' \
     pnpm --filter @stellytics/portal operator:create --email <e-mail> --name "<nome>"
   ```

   Os outros operadores saem de `operator:promote` (conta existente que não seja de projeto) com o mesmo `DATABASE_URL`.
5. **Primeiro backup base**, sem esperar o horário do timer:

   ```bash
   ssh root@<ip-da-vm> systemctl start stellytics-backup
   ```

   Confira com `backup-list` (seção Backup): deve aparecer um backup.

## 6. Conferir a produção

Sem login, de qualquer máquina:

```bash
curl -fsS https://<portal_host>/api/auth/ok            # portal: {"ok":true}
curl -fsS https://<ingest_host>/healthz                # gateway: ok
curl -fsS "https://<ingest_host>/c?s=00000000-0000-4000-8000-000000000000"  # desafio {"t":...,"d":12}
curl -s -o /dev/null -w '%{http_code}\n' https://<ingest_host>/api/send    # 404: o Umami não tem rota pública
curl -s -o /dev/null -w '%{http_code}\n' https://<portal_host>/api/send    # 404 também (é o portal, não o Umami)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://<api_host>/v1/metrics  # 401: o coletor exige chave de ingestão
```

De fora da VM (o Docker da VM roda com `userland-proxy` desligado, então `ss` não mostra processo escutando nessas portas; confira pelo lado de fora e pelas regras do Docker):

```bash
nc -vz -w3 <ip-da-vm> 443    # deve abrir (Caddy em Docker)
nc -vz -w3 <ip-da-vm> 5432   # deve falhar (o Postgres só escuta no loopback e o firewall não abre a porta)
```

Na VM (`ssh root@<ip-da-vm>`):

```bash
cd /opt/stellytics/infra/compose
docker compose -f prod.yaml ps            # serviços em execução; upstreams só na rede interna Docker
docker compose -f prod.yaml port caddy 80     # porta HTTP pública
docker compose -f prod.yaml port caddy 443    # porta HTTPS pública
docker compose -f prod.yaml port postgres 5432 # deve mostrar 127.0.0.1
systemctl list-timers stellytics-backup.timer
```

No navegador, o teste que prova o conjunto:

1. Em `https://<portal_host>/sign-up`, crie uma conta com um e-mail seu, confirme pelo link recebido (se o e-mail não chega, o problema é o `smtp_url`/`mail_from`: `docker compose -f prod.yaml logs portal`), crie o projeto em `/onboarding` e cadastre um site em `/sites`.
2. Instale no site o script (o gateway serve `https://<ingest_host>/s/v<versão>/n.js`; versões e hashes SRI em [`packages/tracker/published/sri.json`](../packages/tracker/published/sri.json); trechos de instalação em [`examples/README.md`](../examples/README.md)), abra uma página e, em alguns minutos, veja a visita no painel do site.
3. Entre com a conta de operador em `/operator` e confira que o projeto aparece.
4. Em `/services`, crie um serviço e uma chave de ingestão, aponte um backend para `https://<api_host>` (OTLP/HTTP; guia em [`examples/api-backend/README.md`](../examples/api-backend/README.md)) e veja as requisições no painel do serviço em um ou dois minutos.

Se algo falhar, os logs de cada serviço estão em `docker compose -f prod.yaml logs <serviço>` (caddy, portal, ingest-web, collector, rollup, umami, postgres). O estado de certificados fica em `/srv/stellytics/caddy`.

## Atualizar a aplicação

1. Publique uma release nova (passo 3) e deixe os pacotes novos públicos, se for a primeira vez de algum.
2. Troque os digests em `group_vars/all.yml` e rode `ansible-playbook site.yml -e @secrets.yml`. O playbook confere a assinatura e recria só os contêineres cuja imagem mudou. As migrações do portal rodam na subida (`RUN_MIGRATIONS=true`).
3. Repita a conferência do passo 6.

**Antes de uma versão com migração nova**, force um backup base (`systemctl start stellytics-backup`): as migrações só andam para frente.

**Voltar atrás (rollback).** Ponha em `group_vars/all.yml` os digests da versão anterior e rode o playbook de novo. Isso volta o código, **não o banco**: se a versão nova trouxe uma migração, o esquema continua o novo, e a versão antiga pode não funcionar com ele. Nesse caso, restaure o banco do backup anterior à atualização (seção "Restaurar o banco") antes de subir a imagem antiga. Versões do script de rastreamento já publicadas continuam disponíveis em `/s/` (são imutáveis), então páginas dos tenants não quebram.

**Trocar um segredo.** Mudar uma senha em `secrets.yml` só atualiza o `.env`; os usuários do banco são criados uma vez, no volume vazio, e guardam a senha antiga. Na ordem:

1. Edite o valor em `secrets.yml`.
2. Rode `ansible-playbook site.yml -e @secrets.yml`. O Compose recria os contêineres cujo ambiente mudou (o Postgres, se mudou uma senha de banco) e entrega o `.env` novo. Se o `--wait` do playbook reclamar de um serviço não saudável, é esperado até o passo 3: rode o playbook de novo no fim.
3. Na VM, em `/opt/stellytics/infra/compose`, atualize a senha no banco:
   - `stellytics_ingest_db_password` e `stellytics_collector_db_password`: reaplique o script (idempotente): `docker compose -f prod.yaml exec -T postgres sh < /opt/stellytics/infra/compose/postgres/init/02-ingest-roles.sh`;
   - `stellytics_db_password` e `umami_db_password`: `docker compose -f prod.yaml exec -T postgres psql -U postgres -c "ALTER ROLE stellytics PASSWORD '<nova>'"` (e `ALTER ROLE umami ...`);
   - `postgres_password`: `ALTER ROLE postgres PASSWORD '<nova>'` da mesma forma.
4. Reinicie quem guarda a conexão: `docker compose -f prod.yaml restart portal umami ingest-web`.

Entre a recriação do Postgres (passo 2) e o `ALTER ROLE` (passo 3), o portal, o Umami e o gateway ficam sem conexão com o banco: faça fora do horário de pico. O gateway descarta os eventos desse intervalo.

Efeito dos outros segredos: `portal_auth_secret` invalida todas as sessões do portal (todos entram de novo); `umami_app_secret` invalida as sessões do Umami (se o portal passar a receber 401 dele, gere outra chave com `pnpm --filter @stellytics/portal umami:service-account` e atualize `umami_api_key`); `ingest_proof_secret` invalida os desafios em circulação, e os navegadores pedem um novo no próximo carregamento ou em até 5 minutos, com alguns eventos descartados nesse meio tempo. A `walg_libsodium_key` não pode ser trocada: os backups antigos deixariam de abrir.

## Backup

- **WAL contínuo:** o Postgres manda cada segmento de WAL ao Object Storage pelo `archive_command`, no máximo 60 segundos depois da escrita (`archive_timeout`).
- **Backup base diário** às 03:15 UTC, pelo timer `stellytics-backup.timer`. Mantém os 7 mais novos (`walg_retain_full`).
- **Ver os backups:**

  ```bash
  cd /opt/stellytics/infra/compose
  docker compose -f prod.yaml exec -u postgres postgres wal-g backup-list
  ```

- **Rodar um agora:** `systemctl start stellytics-backup`.
- A restauração é testada a cada PR pelo job `infra` do CI (`infra/compose/test/prod-stack-test.sh`): ela restaura num contêiner novo e confere que voltou também o que foi gravado depois do backup base.

## Restaurar o banco

**Janela de manutenção:** a restauração derruba o portal, a ingestão (eventos descartados) e o Umami até terminar. O backup novo é baixado para um diretório vazio enquanto os dados antigos ficam em `postgres.antes-*` no mesmo volume, então confira que há espaço livre para os dois (`df -h /srv/stellytics`) antes de começar.

Na VM, como root:

```bash
cd /opt/stellytics/infra/compose
systemctl stop stellytics-backup.timer
docker compose -f prod.yaml stop portal ingest-web collector rollup umami postgres

# Guarda os dados atuais (não apague até conferir a restauração).
mv /srv/stellytics/postgres /srv/stellytics/postgres.antes-$(date +%F-%H%M)
mkdir /srv/stellytics/postgres

# Traz o backup mais novo e todo o WAL depois dele.
docker compose -f prod.yaml run --rm --no-deps --entrypoint sh postgres -c \
  'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore LATEST"'

docker compose -f prod.yaml up -d --wait
systemctl start stellytics-backup.timer
systemctl start stellytics-backup   # novo backup base logo depois da restauração
```

Na subida, o Postgres aplica o WAL arquivado e abre o banco numa linha do tempo nova; o WAL-G continua arquivando a partir dela.

**Voltar a um horário** (por exemplo, antes de um erro às 02:00): um backup base já contém tudo o que aconteceu até ele terminar, então o ponto de partida precisa ser um backup **concluído antes** do horário escolhido. Liste os backups e use o nome do último que terminou antes dele:

```bash
docker compose -f prod.yaml run --rm --no-deps postgres wal-g backup-list --detail

# No lugar do stellytics-restore LATEST do bloco acima:
docker compose -f prod.yaml run --rm --no-deps \
  -e BACKUP=<nome-do-backup> -e TARGET='2026-11-14 01:59:00+00' --entrypoint sh postgres -c \
  'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore \"$BACKUP\" \"$TARGET\""'
```

O `stellytics-restore` descarta os alvos de recuperação que vieram dentro do backup (de uma restauração anterior), então cada restauração usa só o alvo pedido.

## Estado do OpenTofu

O estado fica em `infra/opentofu/terraform.tfstate`, na máquina de quem aplica (fora do git, porque tem dados da infraestrutura). Para compartilhar entre pessoas, guarde-o no próprio Object Storage: acrescente o bloco `backend` **dentro** do bloco `terraform` que já existe em `versions.tf`:

```hcl
terraform {
  # ... required_version e required_providers como estão ...

  backend "s3" {
    bucket                      = "<bucket-do-estado>"
    key                         = "stellytics/production.tfstate"
    region                      = "nbg1"
    endpoints                   = { s3 = "https://nbg1.your-objectstorage.com" }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
```

Depois rode `tofu init -migrate-state`. As credenciais vêm de `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`.

## Monitoramento

Uma VM separada, em outro data center (`fsn1`), testa de fora o portal e a ingestão a cada 15 segundos e manda e-mail quando algo cai ([ADR 0005](adr/0005-monitoramento-externo.md)). Ela é criada pelo mesmo `tofu apply` (saída `monitor_ipv4`).

Faça depois do deploy (passo 4) e do DNS, senão o monitor já nasce alertando.

1. No `inventory/production.yml`, confirme o host `monitor` com o `monitor_ipv4` (veja o `.example`). Aceite a chave SSH dele uma vez: `ssh root@<monitor_ipv4> true`.
2. Em `group_vars/all.yml`, preencha `monitor_alert_email`, `monitor_smtp_smarthost` (`host:porta`), `monitor_smtp_from` e, se o SMTP pedir login, `monitor_smtp_username`. No `secrets.yml`, preencha `monitor_smtp_password`.
3. **Recomendado:** configure um serviço externo de sinal de vida (qualquer um que receba um POST periódico e avise quando ele parar) e ponha a URL em `monitor_deadman_url`. Sem isso, se a VM de monitoramento cair, ninguém fica sabendo.
4. Rode, de `infra/ansible/`:

   ```bash
   ansible-playbook monitoring.yml -e @secrets.yml
   ```

| Alerta | Quando |
|---|---|
| `EndpointDown` | Portal, gateway web ou ingestão de API sem resposta 2xx por 1 minuto |
| `TLSCertificateExpiringSoon` | Certificado vencendo em menos de 14 dias (a renovação automática falhou) |
| `ProbeFailing` | O Prometheus não consegue nem pedir o teste de um alvo ao blackbox |
| `ProberDown` | O blackbox exporter, que faz os testes, está fora do ar |
| `ReplicationStopped` / `ReplicationMonitorDown` | Com monitoramento de réplica habilitado: slot ausente ou sem streaming, ou falha de coleta por 2 minutos |
| `ReplicationLagHigh` / `ReplicationSlotWALHigh` | Atraso acima de 256 MiB por 5 minutos ou retenção acima de 5 GiB por 2 minutos |

Confira que o monitoramento enxerga a produção: no Prometheus (túnel abaixo), a página *Status → Targets* (ou a consulta `probe_success`) deve mostrar `1` para o portal, o gateway e a ingestão de API (`ingest-api`, um POST sem chave que espera o 401 do coletor). Para testar o e-mail de alerta de verdade, na VM de produção rode `docker compose -f prod.yaml stop ingest-web`, espere uns 2 minutos pelo `EndpointDown` e suba de novo (`start ingest-web`). **Parar o `ingest-web` descarta os eventos reais que chegarem nesse intervalo.** Faça o teste no primeiro deploy, antes de haver tenants, ou aceite a perda. O Alertmanager e o Prometheus ficam só no loopback; para vê-los, abra um túnel e acesse `http://127.0.0.1:9090` e `http://127.0.0.1:9093`:

```bash
ssh -N -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@<monitor_ipv4>
```

**Ingestão de API:** `monitor_api_url` já é montada a partir de `api_host` em `group_vars/all.yml`; mantenha os dois alinhados se mudar o domínio e reaplique `monitoring.yml`. O teste do blackbox só confirma que o coletor exige chave (401), não que uma métrica autorizada será gravada.

## Alta disponibilidade (opcional, degraus 1 e 2 do ADR 0009)

> Tudo desligado por padrão: com os valores padrão, `site.yml`, o `prod.yaml` e o `.env` ficam **idênticos** aos de antes (conferido com `docker compose config` e renderizando o `env.j2`). Isto entrega a **configuração** das réplicas; **não** entrega failover automático nem as metas de 99,99% e 99,90% ([`docs/sla.md`](sla.md)). Nada disto foi aplicado numa conta real da Hetzner.

O que existe:

| Peça | Arquivos | Para quê |
|---|---|---|
| Primário com replicação | `compose/prod-ha-primary.yaml`, `compose/postgres/init/03-replication.sh`, variável `ha_replication` | Papel `replicator`, `pg_hba` só para a faixa `ha_replication_cidr` (`10.50.0.0/16`), limite de WAL por slot (`max_slot_wal_keep_size`, 10 GB), Postgres e Umami publicados no IP privado `ha_private_ip` |
| Réplica do Postgres | `standby.yml`, papel `postgres_standby`, `compose/prod-standby.yaml`, `compose/postgres/standby-entrypoint.sh` | `pg_basebackup` + `standby.signal` + slot de replicação, hot standby somente leitura |
| Ingestão extra | `ingest.yml`, papel `stellytics_ingest`, `compose/prod-ingest.yaml`, `caddy/Caddyfile.ingest` | Só Caddy e gateway web, lendo `ingest_site` (como `stellytics_ingest`) e repassando ao Umami do primário pela rede privada |
| Failover manual | [`runbooks/failover-do-banco.md`](runbooks/failover-do-banco.md) | Promover a réplica, mover a pilha, o que fazer com o antigo primário |

Ordem (cada passo é um `ansible-playbook` de `infra/ansible`, com o `secrets.yml`):

1. **OpenTofu:** ligue `ha_db_standby` e/ou `ha_ingest_replicas` (ver `infra/opentofu/variables.tf`; cria recursos pagos). Preencha o inventário (`inventory/production.example.yml`, grupos `ingest` e `standby`) com os IPs públicos das VMs e o volume da réplica (o OpenTofu só exporta o IP privado da réplica; os demais vêm do console).
2. **Segredo novo:** `replicator_db_password` em `secrets.yml` (`openssl rand -hex 32`). Guarde-o como os demais.
3. **Primário:** `ansible-playbook site.yml -e @secrets.yml -e ha_replication=true`. Recria o contêiner do Postgres (reinício curto do banco, e o portal, o Umami e o gateway perdem a conexão por alguns segundos) e aplica `03-replication.sh` no volume existente (idempotente). O Docker só sobe o contêiner se o IP privado existir na VM: depois de reiniciar a VM, confira que a interface da rede privada subiu antes do Docker.
4. **Réplica:** `ansible-playbook standby.yml -e @secrets.yml`. Copia o primário pela rede privada (o tempo cresce com o tamanho do banco; no teste local, um banco de poucos MB levou 6 s) e confere `pg_is_in_recovery() = t`.
5. **Conferir:**

   ```bash
   # no primário
   docker compose -f prod.yaml -f prod-ha-primary.yaml exec -T postgres psql -U postgres -Atc \
     "SELECT state, sync_state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS bytes_atras FROM pg_stat_replication"
   # na réplica
   docker compose -f prod-standby.yaml exec -T postgres psql -U postgres -d stellytics -Atc "SELECT pg_is_in_recovery()"
   ```

6. **Monitorar a réplica (opcional, recomendado):** a opção OpenTofu `ha_db_standby=true` conecta a VM de monitoramento à rede HA em `10.50.0.40`. Publique primeiro uma release assinada contendo a imagem `replication-monitor` e configure `monitor_replication_image` com a referência por digest; o playbook verifica sua assinatura. Gere `replication_monitor_password` com `openssl rand -hex 32` e guarde em `secrets.yml`. Execute `site.yml` e depois `monitoring.yml`, ambos com `-e @secrets.yml -e ha_replication=true -e monitor_replication_enabled=true`. A conta limitada `stellytics_replication_monitor` recebe `pg_monitor` e só entra no banco `postgres` pelo endereço `monitor_replication_cidr` (padrão `10.50.0.40/32`); a conexão trafega sem TLS pela rede privada. Restrinja a rede privada e mantenha a senha protegida. Confira no Prometheus `stellytics_replication_scrape_success=1`, `stellytics_replication_slot_exists=1` e `stellytics_replication_streaming=1`. Se promover a réplica, atualize `ha_primary_private_ip` para o novo primário e execute ambos os playbooks novamente. A rede real da Hetzner ainda não foi testada.
7. **Ingestão extra:** use o **mesmo** `ingest_proof_secret`, `stellytics_ingest_db_password` e `ingest_web_image` (por digest, verificada com cosign) do primário e rode `ansible-playbook ingest.yml -e @secrets.yml`. O Caddy dessas VMs só publica `/e`, `/c`, `/s/*` e `/healthz` do host da ingestão.

Limites e cuidados:

- **Backup:** só o primário agenda o `stellytics-backup`. A réplica não arquiva WAL enquanto é réplica (testado: `archived_count = 0`) nem faz backup base; o WAL-G continua exatamente como antes no primário (testado). Depois de uma promoção, a nova linha do tempo arquiva no mesmo prefixo; faça um backup base logo.
- **Slot:** uma réplica parada retém WAL no primário até 10 GB (`ha_replication_max_slot_wal_keep`); passou disso, o slot é invalidado e a réplica precisa ser refeita (apague o diretório de dados dela e rode `standby.yml`). Sem réplica não há slot e o primário não guarda WAL a mais.
- **Rede:** o Postgres e o Umami do primário passam a escutar o IP privado. O pg_hba.conf da imagem termina em `host all all all scram-sha-256`, que deixaria `postgres`, `umami`, `stellytics` e `stellytics_collector` alcançáveis por essa rede só com senha; por isso o `03-replication.sh` insere, antes dela e para cada faixa de `ha_replication_cidr`, `stellytics_ingest` (só no banco `stellytics`), `replicator` (só replicação) e `reject` para todo o resto (testado: de um cliente na faixa, os quatro papéis são rejeitados e `stellytics_ingest` e `replicator` funcionam; o tráfego do Compose vem de 172.30.0.0/24 e não é afetado). **Risco que sobra:** o Umami (3000) é alcançável por qualquer host da rede privada, sem autenticação em `/api/send`, e aceita o cabeçalho de IP do cliente: quem controlar uma VM da rede injeta eventos com IP falso. Mitigação: firewall da Hetzner liberando 3000 e 5432 só entre os IPs privados conhecidos (o OpenTofu de hoje não faz isso; é pendência). A rede privada real **não foi testada**; no teste local a faixa é a de uma rede do Docker.
- **TLS das réplicas de ingestão:** cada VM pede o certificado por HTTP-01. Atrás de um balanceador que repassa 80 e 443, o desafio cai numa VM qualquer e pode falhar; certificado no balanceador ou outro método continua em aberto (ADR 0009). O balanceador, o IP flutuante e o DNS **não** são configurados por aqui.
- **Limites por instância:** `RATE_LIMIT` e `FINGERPRINT_LIMIT` valem por réplica (ADR 0009); com N réplicas o limite efetivo pode chegar a N vezes. Três variáveis do gateway chegam por `.env` (Compose) ou por variáveis do Ansible, todas desligadas por padrão (comportamento idêntico ao de antes):

  | Compose / `.env` | Ansible | Padrão | Quando ligar |
  |---|---|---|---|
  | `INGEST_SITE_STALE_TTL` | `ingest_site_stale_ttl` | `0` | Máx. 1 h (ex.: `10m`). Com o banco fora, o gateway serve a última resposta de um site **aceito** por esse tempo. Contrapartida: tenant removido durante a queda segue aceitando eventos até `SITE_CACHE_TTL` + este valor. |
  | `INGEST_RELAY_MAX_INFLIGHT` | `ingest_relay_max_inflight` | `0` (sem limite) | Só se o Umami saturar e o gateway começar a acumular memória. Sob saturação, o gateway responde `204` e registra os descartes no log; diferenças de tempo ainda podem fornecer pistas (ADR 0011). |
  | `INGEST_RELAY_QUEUE_WAIT` | `ingest_relay_queue_wait` | `250ms` | Só vale com o limite acima ligado (0 a 10 s). |
- **Portal e Umami** continuam numa VM só, com o banco local a ela (`postgres:5432` no `prod.yaml`).

## O que o guia ainda não cobre

- **Coletor de API:** está no `prod.yaml` e no Caddy ([ADR 0014](adr/0014-infra-em-docker-compose.md)), mas nunca rodou numa conta real. O Caddy não limita requisições por IP e o coletor não limita por chave; o teto de memória do contêiner é `collector_mem_limit` (padrão `512m`). As VMs extras de ingestão (`prod-ingest.yaml`) só têm o gateway web: a ingestão de API continua numa VM só.
- **API de leitura do SCF (`/api/v1`, [#48](https://github.com/romulospl/stellytics/issues/48)):** é servida pelo portal, no host `app.stellytics.xyz`. O Caddy não aplica limite por IP. O limite existente é do portal, em memória e por instância ([ADR 0006](adr/0006-api-de-leitura-do-scf.md)); um ataque distribuído não é contido.
- **Domínio e DNS na IaC:** hoje os registros são criados à mão (ADR 0004).
- **SMTP de produção:** o guia exige um provedor, mas não escolhe nem configura nenhum (SPF, DKIM e DMARC do domínio do `mail_from` ficam com você).
- **Transferir a operação para outra equipe:** plano, ordem, janela, migração de dados testada localmente (`infra/scripts/db-export.sh` e `db-import.sh`) e critérios de aceite em [`docs/transferencia.md`](transferencia.md) ([#54](https://github.com/romulospl/stellytics/issues/54)).
- **Alta disponibilidade:** por padrão é uma VM só; se ela cair, o serviço cai até a recriação (restauração do backup em VM nova, seção "Restaurar o banco"). A seção "Alta disponibilidade" acima configura réplica do Postgres e ingestão extra, mas o failover é manual, não há balanceador nem IP flutuante configurado e nada foi aplicado numa conta real.
- **Teste de restauração em produção:** a restauração é testada no CI com S3 local, não contra o bucket real. Faça um ensaio numa VM descartável antes de precisar dela.
- **Atualização do Umami e do Postgres:** só por PR (imagens por digest no `prod.yaml`); não há guia de migração de versão maior do Postgres. A configuração do Caddy é entregue pelo Ansible e executada em contêiner.

## Como este guia foi conferido

Sem credenciais da Hetzner, de DNS ou de SMTP, foi possível conferir:

- `docker compose -f infra/compose/prod.yaml config` com um `.env` montado a partir do `env.j2` do Ansible (todas as variáveis obrigatórias do Compose vêm de lá);
- `tofu validate` (contêiner `ghcr.io/opentofu/opentofu:1.13.2`) em `infra/opentofu/`;
- `ansible-playbook --syntax-check` de `site.yml`, `monitoring.yml`, `ingest.yml` e `standby.yml` (ansible-core 2.21) com os arquivos de exemplo;
- os nomes de variáveis, saídas do OpenTofu, scripts (`pnpm umami:service-account`, `operator:create`) e caminhos citados, contra os arquivos do repositório;
- as rotas TLS do Caddy, os serviços internos, uma métrica de API gravada, o backup cifrado e a restauração, pelo job `infra` do CI (`infra/compose/test/prod-stack-test.sh`);
- a replicação, a promoção e a ingestão replicada, em Docker local, por `infra/compose/test/ha-replication-test.sh` (job `infra`).

**Não foi possível conferir** sem credenciais: o `tofu apply` e o `ansible-playbook` de verdade, a emissão do certificado, o envio de e-mail, o `cosign verify` contra imagens reais (ainda não há release publicada) a visibilidade dos pacotes no GHCR e o bloco `backend "s3"` do estado do OpenTofu (`region = "nbg1"` e os `skip_*`). Os passos do console da Hetzner e do GitHub seguem a documentação dessas ferramentas e podem ter mudado de nome na interface.
