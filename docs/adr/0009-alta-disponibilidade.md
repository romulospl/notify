# 0009. Alta disponibilidade para as metas de SLA

- **Status:** Rejeitado (0016)
- **Data:** 15/11/2026
- **Issue:** [#52](https://github.com/romulospl/stellytics/issues/52)
- **Depende de:** [ADR 0002](0002-arquitetura-e-stack.md), [ADR 0004](0004-hospedagem-e-backup.md), [ADR 0005](0005-monitoramento-externo.md)

## Contexto

O RFP "Web and API Analytics for Stellar Ecosystem Projects" (`scf-web-api-analytics`) pede, na seção de hospedagem e entrega, **metas** de 99,99% de disponibilidade na ingestão, 99,90% nos painéis e correção de vulnerabilidades críticas e altas em 24 horas. Fonte: Stellar Light (`scout.getRfps`, via MCP stellar-raven), consultada em 15/11/2026; o texto diz "targets", não obrigações contratuais. Os compromissos que o projeto assume ficam em [`docs/sla.md`](../sla.md); este ADR decide a arquitetura que os sustentaria e diz, para cada desenho, qual meta ele de fato sustenta.

### Orçamento de erro

| Meta | Janela de 30 dias | Janela de 365 dias |
|---|---|---|
| 99,99% | 0,0001 x 43.200 min = **4,32 min** | 52,6 min |
| 99,90% | 0,001 x 43.200 min = **43,2 min** | 8,76 h |

A produção atual (ADR 0004) é **uma VM em `nbg1`** com Caddy, portal, gateway, Umami e Postgres, um único volume, um único operador humano e o monitor em outra VM (`fsn1`, ADR 0005). Contra o orçamento:

- O alerta `EndpointDown` só dispara depois de **1 minuto** sem 2xx, com sondagem a cada 15 s, e chega por e-mail. Detectar já gasta pelo menos 1 min 45 s dos 4,32 min (1 min de `for`, até 15 s de sondagem e 30 s de `group_wait` do Alertmanager, sem contar o SMTP), antes de qualquer pessoa agir.
- Recriar a VM do zero (`docs/deploy.md`, passos 1 e 4) e, se o volume for perdido, restaurar o banco leva muito mais que 4 minutos. O tempo de restauração **nunca foi medido** numa produção real (não há deploy real ainda).
- Cada `docker compose up -d` de uma versão nova reinicia contêineres; com uma VM, todo deploy é uma janela de indisponibilidade de segundos a minutos (não medida).
- **Um incidente curto por mês basta para estourar 99,99%.** Com uma VM, a meta de 99,99% é inalcançável por construção, não por falta de cuidado.

### Pontos únicos de falha reais (lidos em `infra/`, `docs/` e nos ADRs)

| # | Ponto | Efeito se falhar | Evidência |
|---|---|---|---|
| 1 | A VM `stellytics` (`hcloud_server.stellytics`) | Tudo cai: portal, ingestão, Umami, banco | `infra/opentofu/main.tf`; ADR 0004 ("Pontos únicos de falha") |
| 2 | O data center `nbg1` e sua rede | Idem, e o volume e o bucket do backup estão no mesmo local | ADR 0004 item 1 |
| 3 | O Postgres único e o volume de dados | Sem banco: o portal cai, o Umami não grava, o gateway devolve 503 quando o cache de `ingest_site` expira (até 1 min), o coletor recusa chaves novas depois de 60 s | `services/ingest-web/README.md`; CLAUDE.md |
| 4 | O Umami único | Sem ele, o gateway não tem para onde repassar eventos web | `prod.yaml` |
| 5 | O Caddy único (TLS, ACME) | Sem entrada pública; falha de renovação derruba tudo | `Caddyfile`; alerta `TLSCertificateExpiringSoon` |
| 6 | Migrações do portal no boot (`RUN_MIGRATIONS=true`) | Migração lenta ou com erro mantém o portal fora | `prod.yaml` |
| 7 | Deploy manual pelo Ansible, por uma pessoa | Sem pager; MTTR depende de uma pessoa estar disponível | `docs/runbooks/README.md` ("hoje a operação é de uma pessoa só") |
| 8 | Monitor único em `fsn1`, um só ponto de vista, alertas por e-mail | Falso positivo ou negativo se a rota do monitor falhar; sem sinal de vida externo, a queda dele passa despercebida | ADR 0005; `monitor_deadman_url` opcional |
| 9 | DNS fora da IaC, provedor não escolhido | Troca de IP depende de TTL e de ação manual | ADR 0004 item 4 |
| 10 | SMTP externo (`SMTP_URL`) | Cadastro e recuperação de senha param (não os painéis nem a ingestão) | `prod.yaml` |
| 11 | GHCR e cosign no momento do deploy | Não se publica correção se o registro estiver fora (a produção em execução não é afetada) | `docs/runbooks/vulnerabilidades.md` |
| 12 | Coletor de API e `rollup` **não estão em produção** | A ingestão de API não existe em produção hoje; a meta de 99,99% "na ingestão de API" não tem o que medir | `docs/deploy.md`; `monitor_api_url` vazio |
| 13 | RPO/RTO do backup: WAL contínuo com `archive_timeout` de 60 s dá RPO de cerca de 1 min, mas o RTO é o tempo de restauração, não medido | Perda de volume = horas de indisponibilidade | ADR 0004 item 5 |

### O que o código já ajuda e o que atrapalha

- **A prova de JS já é sem estado** entre instâncias: o token é assinado com HMAC (`PROOF_SECRET`); qualquer réplica valida o desafio emitido por outra, desde que todas usem o mesmo segredo.
- **O gateway não guarda dados**: o cache de `ingest_site` (no máximo 1 min) é só desempenho.
- **O limite de taxa por IP e o limite de fingerprints por IP e site são em memória, por instância** (`internal/limit`, `internal/fingerprint`). Com N réplicas e balanceamento sem afinidade por IP, o limite efetivo vira até N vezes o configurado, e o mesmo IP pode acumular fingerprints em cada réplica. O limite de leitura do portal (ADR 0006) tem o mesmo defeito. O limite do Better Auth é provavelmente em memória: o código não configura `storage` (`src/lib/auth.ts`, bloco `rateLimit`).
- **O script tem `keepalive: true` mas não reenvia** (`packages/tracker/src/tracker.ts`): evento enviado durante uma queda é perdido.
- **O coletor não tem retentativa** no exporter `stellyticspg` (de propósito, porque recalcular o delta daria zero) e o rollup é idempotente; uma fila antes do exporter exigiria repensar isso.
- **As migrações rodam no boot do portal**; com várias réplicas do portal, só uma pode rodar migração.

## Decisão

Adotar a arquitetura em **degraus**, cada um com a meta que realmente sustenta, e **implementar só o primeiro passo de provisionamento** (variáveis do OpenTofu desligadas por padrão). O resto fica planejado e não é prometido.

1. **Degrau 0 (hoje): uma VM.** Sustenta, no melhor caso, uma meta de melhor esforço, sem número comprometido. Não sustenta 99,99% nem garante 99,9%.
2. **Degrau 1: ingestão replicada.** Duas ou mais VMs de ingestão (gateway web e, quando existir em produção, coletor, cada uma com seu Caddy) em locais diferentes da mesma zona de rede da Hetzner (`nbg1` e `fsn1`), atrás de um **Load Balancer da Hetzner** com health checks (`/healthz`) ou de um IP flutuante reatribuído. O banco continua único. Todas as réplicas usam o mesmo `PROOF_SECRET`. O gateway passa a **servir o último valor do cache de `ingest_site` quando o banco falha** (mudança de código, não feita). Sustenta, na melhor hipótese, **99,9% na ingestão**, limitada pelo banco único e pelo próprio balanceador; **não** 99,99%.
3. **Degrau 2: Postgres com réplica e failover.** Réplica em streaming (VM e volume próprios, em outro local), com promoção manual primeiro e automática depois. Failover automático confiável precisa de testemunha (três nós, ou Patroni com etcd); com dois nós há risco de dois primários. Sustenta **99,9% nos painéis** se o portal também for replicado (uma instância faz migrações) e o failover for ensaiado. 99,99% só seria defensável com três nós de banco, deploy sem interrupção, failover medido em segundos e um período de medição real; isso **não** é prometido neste ADR.
4. **Degrau 3 (não adotado agora): ingestão que tolera banco fora com fila.** Um buffer em disco ou fila antes do Umami e do coletor evitaria perder eventos durante a queda do banco. Exige componente novo, pois o Umami grava direto no Postgres e o exporter do coletor não retenta. Fica como alternativa para quando o banco for o fator limitante medido.
5. **O que a IaC cria agora, desligado por padrão** (`infra/opentofu/`): `ha_ingest_replicas` (0 a 3 VMs de ingestão em `ha_ingest_location`), `ha_floating_ip` (IP flutuante IPv4 apontado para a VM principal), `ha_db_standby` (VM e volume de réplica em `ha_db_standby_location`) e uma rede privada `10.50.0.0/16` criada quando qualquer um estiver ligado. Com os padrões, os `resource_changes` do plano são idênticos aos anteriores e os `output_changes` só ganham as três saídas novas, vazias (verificado, ver PR). Isto só **provisiona**; não configura replicação, Caddy nas réplicas, balanceamento nem o IP flutuante dentro do sistema. **Locais:** o standby e as VMs de ingestão têm precondition contra o local da principal (`location`, `nbg1`); os padrões deles são `fsn1`, o mesmo local do monitor (`monitor_location`). Num failover para `fsn1`, o monitor deixa de ser independente da produção (ADR 0005). O IP flutuante é só IPv4: o registro AAAA continua apontando para a VM antiga e não migra no failover. Saídas novas em `outputs.tf`: `ingest_ipv4`, `floating_ipv4`, `standby_private_ip` (vazias ou nulas com os padrões). A réplica do Postgres usa o firewall do monitor (só SSH e ping) e a rede privada.
6. **Vulnerabilidades:** o projeto assume avaliação de possíveis críticas e altas em até 48 horas e correção em até 7 dias corridos (crítica) e 14 (alta); contenção de críticas em 72 h e as 24 h do RFP são metas, não compromissos; o compromisso e a exceção para correções de segurança estão em [`docs/sla.md`](../sla.md) e no [runbook](../runbooks/vulnerabilidades.md).

## Alternativas consideradas

Custos mensais são **estimativas de ordem de grandeza** feitas de memória, sem consultar a tabela de preços da Hetzner nesta data; confirme em `hcloud server-type list` e na página de preços antes de decidir. Não há VM real para medir.

| Alternativa | Prós | Contras | Custo mensal extra (estimativa, não verificado) | Meta que sustenta |
|---|---|---|---|---|
| Uma VM (hoje) | Simples, barato | Todos os pontos únicos acima | 0 | Nenhuma comprometida |
| 2+ VMs de ingestão atrás do Load Balancer da Hetzner | Elimina a VM como ponto único da ingestão; deploy sem interrupção possível | Banco continua único; o balanceador em um local é novo ponto único; TLS (ACME com várias VMs ou certificado no balanceador) por resolver; limites por IP multiplicados por N | Cerca de 5 a 15 EUR por VM extra e 5 a 10 EUR pelo balanceador | Até 99,9% na ingestão |
| IP flutuante com reatribuição manual ou por script | Barato; DNS fixo | Failover não é automático; tempo de troca não medido; um único Caddy ativo | Cerca de 3 a 5 EUR | Melhora o RTO, não o RPO nem a meta |
| Postgres com réplica e promoção manual | Perda de volume ou VM não exige restauração do backup | Promoção depende de pessoa; dois nós sem testemunha | Cerca de 5 a 15 EUR (VM) mais 2 a 4 EUR (volume de 40 GB) | Painéis a 99,9%, com ressalvas |
| Postgres com Patroni (3 nós) | Failover automático e seguro | Três nós, etcd, muita operação para uma pessoa só; Umami e o portal precisam reconectar | Cerca de 20 a 45 EUR | Condição necessária (não suficiente) para 99,99% |
| Postgres gerenciado do provedor | Failover pronto | Já descartado no ADR 0004 (amarra ao provedor, sai do Compose) | Não estimado | Não avaliado |
| Ingestão com fila ou buffer | Não perde evento com o banco fora | Componente novo; o Umami grava direto no banco; exporter do coletor sem retentativa | Não estimado | Protege a integridade dos dados, não a disponibilidade medida do endpoint |
| Duas regiões ou dois provedores | Sobrevive à falha de um provedor | Dados na UE (residência) limitam as opções; DNS com failover; custo e complexidade altos para o MVP | Não estimado | Necessário para 99,99% de verdade; fora do alcance atual |

**Custo total do conjunto dos degraus 1 e 2, estimativa:** cerca de 20 a 50 EUR por mês acima do custo atual. Marcada como estimativa; não use em orçamento sem conferir os preços.

## Consequências

- **Honestidade das metas:** o projeto passa a tratar 99,99% na ingestão e 99,90% nos painéis como **metas do RFP**, não como compromisso assumido, até haver o degrau correspondente em produção, medição e ensaio de failover. Ver [`docs/sla.md`](../sla.md).
- **Variáveis novas no OpenTofu** (todas desligadas) e recursos novos só quando ligadas. Ligar qualquer uma cria recursos pagos; o `delete_protection` e o `prevent_destroy` valem para os volumes e o IP flutuante.
- **Atualização (segunda parte da #52):** passaram a existir, desligados por padrão, `infra/ansible/ingest.yml` e `standby.yml` (papéis `stellytics_ingest` e `postgres_standby`), a variável `ha_replication` do `site.yml`, os arquivos `infra/compose/prod-ha-primary.yaml`, `prod-standby.yaml` e `prod-ingest.yaml`, o `Caddyfile.ingest` e o runbook [`failover-do-banco`](../runbooks/failover-do-banco.md). Replicação em streaming assíncrona com slot físico, promoção **manual** e o antigo primário refeito por `pg_basebackup`; o primário só ganha papel `replicator`, linha de `pg_hba` por faixa de rede, `max_slot_wal_keep_size` e portas no IP privado. Testado em Docker local por `infra/compose/test/ha-replication-test.sh` (replicação, somente leitura, promoção, gateways lendo do banco promovido, WAL-G depois da promoção). RPO e RTO esperados são estimativas (runbook). **Não** testado: rede privada, firewalls, balanceador e IP flutuante da Hetzner, failover automático, carga.
- **Atualização (cache vencido no gateway):** o gateway passou a aceitar `SITE_STALE_TTL` (padrão `0`, desligado; máximo `1h`). Com a consulta à `ingest_site` falhando, ele serve a última resposta conhecida do site por até esse tempo depois de vencida; site nunca visto, desconhecido ou recusado não ganha stale: dentro do `SITE_CACHE_TTL` o recusado ainda recebe `204` (e o evento é descartado), mas passado esse prazo, durante a falha, volta a `503` (igual ao desconhecido, para a falha não revelar quais IDs o gateway conhece); e há uma só consulta em voo por site. **Decisão e custo:** trocamos perda de eventos por uma janela de recusa tardia. Um tenant removido ou site arquivado durante a queda do banco segue aceitando eventos até `SITE_CACHE_TTL` + `SITE_STALE_TTL`, e só a volta do banco aplica a recusa. Para análise web, perder eventos numa queda curta custa mais que aceitar alguns eventos de um tenant recém-removido, que não expõe dado de ninguém. Por isso o padrão é desligado e a escolha do valor é do operador. Testado com falha injetada (testes Go) e com Postgres real parado em Docker. Sites aceitos e recusados ficam em mapas separados e limitados, e só site aceito ganha stale; um circuit breaker de 2 s serve o vencido na hora quando o banco pendura. O `prod.yaml` e o `prod-ingest.yaml` (os dois sobem o gateway) ainda não repassam a variável (como `SITE_CACHE_TTL`): ligar exige editar os dois.
- **Trabalho que continua pendente** (sem isso, ligar as variáveis não entrega HA):
  - Ansible: configuração do IP flutuante na interface da VM;
  - Postgres: decisão sobre failover automático (testemunha), e o portal e o Umami ainda falam com o `postgres` do próprio Compose (o failover suportado move a pilha inteira para a VM da réplica);
  - Caddy: certificados com várias VMs (HTTP-01 por trás de balanceador é problema; DNS-01 exige módulo que a imagem não tem) ou terminação no balanceador;
  - código do gateway: reavaliar limites por instância (dividir `RATE_LIMIT` e `FINGERPRINT_LIMIT` por N ou limitar no balanceador);
  - portal: uma só instância com `RUN_MIGRATIONS=true`;
  - ingestão de API: coletor e `rollup` ainda precisam entrar no `prod.yaml`;
  - monitoramento: sondagem de mais de um ponto de vista, `monitor_api_url`, alerta de latência de replicação e idade do backup, pager em vez de e-mail;
  - medir RTO de restauração e de failover em ensaio.
- **O balanceador em um local é novo ponto único**, a menos que se use mais de um (não decidido).
- **Não verificado:** preços, SLA da Hetzner para VMs, volumes, IP flutuante e Load Balancer, tempo de reatribuição do IP flutuante, comportamento do Load Balancer com verificação de saúde e afinidade por IP, e tudo o que depende de uma conta real.
