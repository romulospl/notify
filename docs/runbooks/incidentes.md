# Runbook: incidentes

Serve para os quatro alertas reais do monitoramento externo ([`alerts.yml`](../../infra/monitoring/prometheus/rules/alerts.yml), [ADR 0005](../adr/0005-monitoramento-externo.md)) e para queda do portal ou da ingestão web. O alerta `Watchdog` é um sinal de vida sempre ativo, não é incidente; se ele **parar de chegar** ao serviço externo configurado em `DEADMAN_URL`, o problema é o host de monitoramento (ver `ProberDown`).

## Triagem inicial (vale para todos)

1. Veja de fora, de qualquer máquina (comandos do passo 3 ("Check production") de [`docs/deploy.md`](../deploy.md)):

   ```bash
   curl -fsS https://<portal_host>/api/auth/ok           # portal: {"ok":true}
   curl -fsS https://<ingest_host>/healthz               # gateway
   curl -fsS "https://<ingest_host>/c?s=00000000-0000-4000-8000-000000000000"
   ```

2. Entre na VPS, vá à pasta do checkout e veja o estado:

   ```bash
   docker compose -f prod.yaml ps
   df -h /srv/stellytics
   ```

3. Se nem o SSH entra, a VPS caiu: veja o console do provedor (reiniciar, ver o disco). Os dados ficam em `STELLYTICS_DATA_DIR` (padrão `/srv/stellytics`). Recriar a VPS: `init.sh` e `deploy.sh` ([`docs/deploy.md`](../deploy.md)) e a restauração se os dados foram perdidos ([backup e restauração](backup-e-restauracao.md)).

## EndpointDown

**Sintomas.** E-mail `<componente> is down`: o alvo (portal, gateway web ou ingestão de API) ficou 1 minuto sem a resposta esperada.

**Diagnóstico.**

- Qual componente? Está no rótulo `component` do e-mail. Se só um caiu, o problema é do serviço dele; se todos caíram, é a VPS, o Caddy ou a rede.
- Na VPS: `docker compose -f prod.yaml ps` (procure `unhealthy`, `restarting` ou ausente) e `docker compose -f prod.yaml logs --tail 200 <serviço>`.
- O proxy é o serviço Caddy do Compose; ele encaminha pela rede Docker para `portal`, `ingest-web` e `collector`. No Compose, `ingest-web` depende de `postgres`, `umami` e `portal`; `collector` e `rollup` dependem de `postgres` e `portal`; `portal` e `umami` dependem de `postgres`. Comece pelo mais fundo que esteja ruim (normalmente `postgres`: `df -h /srv/stellytics`, disco cheio derruba tudo).
- Pelo Prometheus do host de monitoramento (túnel `ssh -N -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@<host-do-monitor>`, depois `http://127.0.0.1:9090`): a consulta `probe_success` e a página *Status → Targets* mostram qual alvo falha.

**Ação.**

- Serviço parado ou `unhealthy`: `docker compose -f prod.yaml up -d --wait` (recria o que faltar) ou `docker compose -f prod.yaml restart <serviço>`.
- Versão nova que quebrou: volte o checkout ao commit anterior (ou, se usa imagens de release, `PORTAL_IMAGE` etc. aos digests anteriores no `.env.production`) e rode `sudo ./deploy.sh` de novo (ver `docs/deploy.md`; o rollback não desfaz migração de banco).
- Disco cheio: veja `docker system df` e `du -sh /srv/stellytics/*`; sobras de restauração e imagens antigas são os candidatos. **`postgres.antes-*` só se apaga depois de uma restauração conferida** ([backup e restauração](backup-e-restauracao.md)). `docker image prune` (sem `-a`) remove só imagens soltas; **nunca** rode `docker system prune --volumes`. Aumentar o disco é pelo provedor da VPS.
- Portal sobe mas o painel não mostra dados ou não cria sites: veja se o Umami responde (`docker compose -f prod.yaml ps umami`) e se a `UMAMI_API_KEY` é válida (ver [rotação de segredos](rotacao-de-segredos.md), efeito do `umami_app_secret`).
- Gateway responde `204` mas os eventos não aparecem no painel: o `204` é a resposta também para site recusado e para prova inválida (de propósito). Confira o site na tela do projeto (ativo e não arquivado) e `docker compose -f prod.yaml logs ingest-web`.

**Verificação.** A mesma triagem de fora responde; `docker compose -f prod.yaml ps` com tudo `healthy`; o e-mail de resolvido chega (`send_resolved: true` no `alertmanager.yml` gerado por `configure.sh`; o envio real não foi observado).

**Perda de dados.** Enquanto o `ingest-web` ou o Umami ficam fora, os eventos web chegados são descartados; não há fila. Registre a janela do incidente.

**Escalar** se: o disco ou a VPS têm defeito do provedor (suporte do provedor); o Postgres não sobe e o log indica corrupção (ver [backup e restauração](backup-e-restauracao.md)); ou o incidente passa de 1 hora sem causa.

## TLSCertificateExpiringSoon

**Sintomas.** O certificado de um alvo vence em menos de 14 dias; a renovação automática do Caddy pode estar falhando.

**Diagnóstico.**

- `docker compose -f prod.yaml logs --since=24h caddy`; o estado persistente fica em `/srv/stellytics/caddy`.
- DNS: `dig +short <portal_host>`, `dig +short <ingest_host>` e `dig +short <api_host>` precisam apontar para a VPS (A e AAAA).
- Porta 80 aberta de fora: `nc -vz -w3 <ip-da-vps> 80` (o desafio HTTP-01 do Let's Encrypt passa por ela; o firewall da VPS, configurado pelo operador, precisa abrir 80 e 443).
- O Caddy emite um certificado para cada host do `Caddyfile` (`PORTAL_HOST`, `PORTAL_ALIAS_HOST`, `INGEST_HOST` e `API_HOST`) e os guarda em `/srv/stellytics/caddy`.
- Confira se o contêiner está ativo: `docker compose -f prod.yaml ps caddy`.

**Ação.** Corrija DNS/firewall e confirme que 80/443 chegam à VPS. Caddy tenta emitir e renovar automaticamente; acompanhe `docker compose -f prod.yaml logs -f caddy`.

**Verificação.** `echo | openssl s_client -connect <portal_host>:443 -servername <portal_host> 2>/dev/null | openssl x509 -noout -enddate` mostra data nova; o alerta se resolve (tem `for: 1h`).

**Escalar** se faltarem menos de 3 dias: um certificado vencido derruba portal, ingestão e API. Se o Let's Encrypt estiver fora, aguarde o status deles.

## ProbeFailing

**Sintomas.** `<componente> is not being checked`: o Prometheus não consegue nem pedir o teste ao blackbox para aquele alvo (`up{job="endpoints"} == 0`). O estado real do alvo é desconhecido, e o `EndpointDown` não dispara.

**Diagnóstico.** No host de monitoramento (`cd infra/monitoring` no checkout): `docker compose ps`, `docker compose logs --tail 100 prometheus blackbox`. Procure erro de módulo inexistente em `blackbox/blackbox.yml` ou de configuração depois de rodar `configure.sh`. Teste o alvo à mão pelo Prometheus (túnel acima) em *Status → Targets*.

**Ação.** Restaure a configuração do repositório: atualize o checkout, rode `infra/monitoring/configure.sh <env-file>` e `docker compose up -d --wait` em `infra/monitoring/` (reinicie `prometheus` e `alertmanager` se a configuração não for relida). Enquanto isso, faça a triagem de fora à mão.

**Verificação.** *Status → Targets* com o alvo `UP` e `probe_success` igual a `1`.

**Escalar** se a configuração falhar de forma repetida: o monitor é a única vigilância externa.

## ProberDown

**Sintomas.** `The blackbox prober is down`: o blackbox exporter não responde e nenhum alvo é testado. Este alerta cobre **só o blackbox**. Pela `inhibit_rule` do Alertmanager (no `alertmanager.yml` gerado por `configure.sh`), enquanto ele está ativo, `EndpointDown` e `ProbeFailing` ficam suprimidos: não esperar esses e-mails, e o estado real da produção é desconhecido; faça a triagem de fora à mão.

**E se o host de monitoramento inteiro cair?** Nenhum alerta dispara, porque o Prometheus e o Alertmanager moram nela. A única pista é o **sinal de vida externo** (`Watchdog` enviado a `DEADMAN_URL`) parar de chegar, e **só se `DEADMAN_URL` estiver definido**: sem ele o Watchdog vai para o receptor `blackhole` e ninguém fica sabendo.

**Diagnóstico.** No host de monitoramento (`cd infra/monitoring` no checkout): `docker compose ps` (serviços `prometheus`, `blackbox` e `alertmanager`), `docker compose logs --tail 100 blackbox`. Se o SSH não entra, o host caiu: console do provedor.

**Ação.** `docker compose up -d --wait` na pasta do monitor; se o host caiu, reinicie pelo console (reinício da pilha após reboot real não foi conferido). Para recriar do zero, clone o repositório e rode `infra/monitoring/configure.sh <env-file>` e `docker compose up -d --wait`.

**Verificação.** `probe_success` volta a `1` e `ProberDown` resolve.

**Escalar** se o host do monitor estiver perdido: a produção continua, sem vigilância; recrie num host novo com `configure.sh` (`docs/deploy.md`, "Monitoramento").

## Não testado

Nenhum destes procedimentos foi executado numa produção. O disparo real dos alertas foi coberto só pelo teste do CI (`infra/monitoring/test/`, job `monitoring`). O envio real de e-mail e o reinício após reboot não foram conferidos.
