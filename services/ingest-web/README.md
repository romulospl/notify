# services/ingest-web

Gateway de ingestão web em Go (`net/http`). Fica entre o script de rastreamento (`packages/tracker`) e o Umami, que só deve ser acessível pela rede interna. Criado na [#61](https://github.com/romulospl/stellytics/issues/61).

Já faz:

- recebe o page view, confere o formato e o `websiteId` e repassa ao `/api/send` do Umami;
- repassa o `User-Agent` original, para a detecção de bots do Umami continuar valendo;
- trunca o IP (último octeto do IPv4, /48 no IPv6) antes de qualquer uso e entrega ao Umami só o IP truncado, pelo header de `CLIENT_IP_HEADER`;
- limita o tamanho do corpo (16 KiB) e a taxa por IP truncado;
- serve o script em `/s/vX.Y.Z/`.

Ainda vem: prova de execução de JS (#25), limite de fingerprints por IP (#26), testes de persistência do IP (#24) e a conferência dos nomes contra ad blockers (#23).

## Rotas

| Rota | O que faz |
|---|---|
| `POST /e` | Recebe o evento. Aceita JSON com `Content-Type` `text/plain` (o que o script usa, para evitar o preflight de CORS) ou `application/json`. Responde `204` quando o evento foi repassado. |
| `GET /c?s=<website>` | Desafio da prova de execução de JS (#25): `{"t":"<token>","d":<bits>}`, com `Cache-Control: no-store`. Não consulta a `ingest_site`, então não revela se o site existe. `400` sem UUID em `s`. |
| `OPTIONS /e` | Preflight de CORS, para clientes que mandem `application/json`. |
| `GET /s/<caminho>` | Arquivos de `SCRIPT_DIR`, com `Cache-Control: public, max-age=31536000, immutable` e `Access-Control-Allow-Origin: *` (o SRI exige `crossorigin`). Pastas e caminhos fora de `SCRIPT_DIR` dão `404`. |
| `GET /healthz` | `200 ok`. Não consulta o banco. |

Nenhuma resposta grava cookie.

### Evento aceito

```json
{"type":"event","p":{"t":"<token>","n":"<nonce>"},"payload":{"website":"<uuid>","hostname":"...","url":"/caminho","referrer":"...","title":"...","language":"pt-BR","screen":"1920x1080"}}
```

- `p` é a prova de execução de JS (ver abaixo) e nunca chega ao Umami. Evento sem prova válida recebe `204` e é descartado.

- `type` precisa ser `event`, `website` um UUID e `url` não pode faltar.
- Tamanhos máximos: `url` e `referrer` 2048 bytes, `title` 500, `hostname` 253, `language` 35, `screen` 16.
- **Evento customizado (#50, ADR 0008):** `payload.name` e `payload.data` opcionais. `name`: 1 a 50 caracteres `[A-Za-z0-9_.:-]`, começando por letra ou dígito. `data`: objeto plano com até 10 propriedades, chave de até 40 caracteres `[A-Za-z0-9_.-]` começando por letra ou dígito começando por letra ou dígito, valor string (até 100 bytes), número finito (literal de até 32 caracteres) ou booleano; nulo, lista, objeto aninhado e `data` sem `name` dão `400`. Só esses dois campos, já validados, são repassados ao Umami.
- O payload repassado ao Umami é montado de novo só com esses campos. Qualquer outro (`id`, `ip`, `userAgent`, `timestamp`...) é descartado, porque o Umami deixaria o cliente trocar o IP, o UA ou a identidade da sessão com eles.
- Só os headers `Content-Type`, `User-Agent` e o de `CLIENT_IP_HEADER` chegam ao Umami.

### Respostas de erro

| Status | Quando |
|---|---|
| `400` | JSON inválido ou fora do formato acima |
| `413` | Corpo maior que 16 KiB |
| `415` | `Content-Type` diferente de `text/plain` e `application/json` |
| `429` | Taxa acima do limite para o IP truncado |
| `502` | O Umami recusou o evento ou não respondeu |
| `503` | Falha ao consultar a `ingest_site` |

## Prova de execução de JS (#25)

1. O script pede `GET /c?s=<website>` uma vez por carregamento de página, e de novo a cada 5 minutos em páginas abertas por muito tempo.
2. O token tem 32 bytes em base64url: o horário de emissão, 8 bytes aleatórios e um HMAC-SHA256 truncado sobre os dois e o `website`, com a chave `PROOF_SECRET`.
3. O script procura um `nonce` decimal tal que `SHA-256(token + ":" + nonce)` comece com `d` bits zero (12 por padrão, cerca de 4 mil tentativas com `crypto.subtle`, poucas dezenas de milissegundos).
4. Cada evento leva `{"t": token, "n": nonce}`. O gateway confere o HMAC, o site, a validade (`PROOF_TTL`, com 1 minuto de tolerância para relógio adiantado) e o trabalho.

Um `curl` que só repete o `POST /e` não tem token válido, e o evento é descartado. Quem reimplementar o fluxo fora do navegador consegue a prova: o objetivo é tirar o tráfego barato e encarecer o resto. A detecção de bots do Umami continua valendo, porque o `User-Agent` é repassado. A #26 completa com o limite de fingerprints por IP.

O `crypto.subtle` só existe em contexto seguro (HTTPS ou `localhost`). Numa página servida por HTTP comum, o script não consegue a prova e não envia eventos.

## Limite de fingerprints por IP (#26)

A fingerprint é um hash de `User-Agent`, `Accept-Language`, idioma e tela do evento. Ela fica só em memória e não identifica uma pessoa, porque muita gente tem a mesma combinação.

- Por IP truncado e site, o gateway aceita até `FINGERPRINT_LIMIT` fingerprints distintas vistas dentro de `FINGERPRINT_WINDOW`. A conta é separada por site para que um robô no mesmo /24 (ou na mesma CGNAT), lotando a cota do próprio site, não tire as vagas dos sites de outros tenants.
- A janela é deslizante: cada evento renova a fingerprint dele, e as que ficam paradas por mais que a janela liberam a vaga.
- Eventos de uma fingerprint nova, além do limite, recebem `204` e são descartados. As fingerprints que já estavam no IP continuam contando.

Assim, um robô que troca de `User-Agent` a cada request, a partir de um IP só, não infla as métricas.

O padrão é generoso (50 em 10 minutos) porque o IP truncado junta um /24 inteiro, e uma empresa, universidade ou operadora com CGNAT tem muitos navegadores legítimos. O custo da regra é que, num /24 com mais de 50 navegadores ativos no mesmo site, os que chegarem depois só passam a contar quando vagas ficarem paradas pela janela inteira. Com `0`, a checagem fica desligada.

## Saturação do Umami (`RELAY_MAX_INFLIGHT`)

O Umami satura perto de 200 page views por segundo por instância (`docs/relatorios/carga-1m-dia.md`). Sem limite, o gateway segura cada `POST /e` até o Umami gravar: a 400/s a latência chegou a 5 a 10 s e a memória do gateway passou de 350 MB. Com `RELAY_MAX_INFLIGHT` maior que zero, só o **repasse ao Umami** passa por um semáforo; a prova de JS, `GET /c`, `GET /s/`, `GET /healthz`, o limite por IP, `ingest_site` e fingerprints não mudam, e a ordem delas também não.

- Quem chega sem vaga espera até `RELAY_QUEUE_WAIT`; depois recebe `204` e o evento é descartado. A perda é registrada no log agregado.
- O descarte por saturação **não gasta a cota de fingerprints** do IP (a fingerprint que acabou de entrar na conta é removida).
- O operador vê a taxa de descarte em um aviso de log por minuto, só quando o total muda: `eventos descartados por saturação do repasse ao umami` com `descartados`, `total` e `em_voo` (sem IP, `User-Agent` nem ID de site). O painel de métricas **não** mostra o que foi descartado: durante a saturação as visitas ficam subcontadas.
- A vaga volta em qualquer saída (erro, timeout, cancelamento, panic). Com `RELAY_MAX_INFLIGHT=0` o semáforo nem é montado e o comportamento é o de antes.
- A resposta `204` evita distinguir pelo status a saturação dos descartes por site ou fingerprint; diferenças de tempo ainda podem existir.
- O limite é por processo: com várias instâncias do gateway, o total ao Umami é a soma. Com limite de pelo menos 2, cada site pode ocupar no máximo uma vaga a menos que o total, reservando uma vaga para outros sites. Essa reserva pode ficar ociosa; com limite 1 não há proteção entre sites. Vários sites ainda podem esgotar as vagas em conjunto ([ADR 0011](../../docs/adr/0011-limite-de-repasses-ao-umami.md)).
- Medição histórica com resposta `503` na saturação, a 400 page views/s por 60 s, nesta máquina: sem limite, 5,6 a 10 s de latência nos aceitos, 16.192 de 23.907 em `502` e 355 MB; com `RELAY_MAX_INFLIGHT=16` e `RELAY_QUEUE_WAIT=50ms`, p99 de 202 ms nos aceitos, 31 MB, e todo evento que recebeu `204` foi gravado no Umami (cerca de 53% das requisições recusadas, porque o limite não aumenta a capacidade do Umami). A 116/s (pico do RFP) com 16 vagas não houve `503`. Tabela completa, valores testados e o que não foi testado no ADR 0011. Não há padrão recomendado para produção ainda, e as variáveis são repassadas pelo Compose de produção.

## Contrato com o banco: `ingest_site`

O gateway conecta no banco `stellytics` com o usuário `stellytics_ingest` e só lê a visão `ingest_site(umami_website_id uuid, accepts_ingest boolean)` (spec do E2, seções 4 e 6). `accepts_ingest` é verdadeiro para site não arquivado de tenant ativo. As respostas, positivas e negativas, ficam em memória por `SITE_CACHE_TTL` (no máximo 1 minuto).

**Cache vencido quando o banco cai (`SITE_STALE_TTL`, desligado por padrão).** Com `SITE_STALE_TTL` maior que zero (no máximo `1h`), se a consulta à `ingest_site` falha, o gateway usa a última resposta **aceita** do mesmo site por até esse tempo **depois** de ela vencer, em vez de responder `503`. Regras: site nunca visto, desconhecido ou recusado não ganha stale e continua com `503` (nunca "aceita por padrão"); passado o `SITE_STALE_TTL`, volta o `503`. Os sites aceitos e os recusados ficam em mapas separados, cada um com teto de 10.000 entradas, então quem testa IDs inventados só enche o mapa dos recusados e não expulsa um site aceito. Depois de uma falha, um circuit breaker simples evita novas consultas por 2 s: a resposta vencida sai na hora e uma única sonda em segundo plano testa o banco (sem ele, com o banco pendurado, cada requisição esperaria o teto de 5 s da consulta). O contador de respostas vencidas vai ao log como um aviso agregado por minuto (`respostas`, `total`), sem IP, `User-Agent` nem ID de site. **Janela de risco:** um site arquivado ou um tenant removido durante a queda do banco continua aceitando eventos até `SITE_CACHE_TTL` + `SITE_STALE_TTL` depois da última consulta bem-sucedida; a recusa só passa a valer quando o banco volta. Escolha `SITE_STALE_TTL` pensando nessa janela.

**Com `SITE_STALE_TTL=0`** nada vencido é servido e o erro do banco continua virando `503`. O que mudou, mesmo desligado: a consulta passou a ser compartilhada por site (uma só em voo, com o erro repartido entre quem espera), roda com contexto próprio e teto de 5 s, e cancelar a requisição devolve o erro do contexto (também `503`). O circuit breaker só age com o stale ligado.

- Site desconhecido ou que não aceita ingestão recebe `204`, como um evento aceito, e o evento é descartado. Assim, quem testa IDs não descobre quais existem.
- O usuário `stellytics_ingest` vem de `infra/compose/postgres/init/02-ingest-roles.sh`, e a visão e o `GRANT` vêm da migração `apps/portal/drizzle/0002_ingest_views.sql`.
- O teste de integração (`internal/site/pg_test.go`) aplica as migrações do portal quando a visão não existe, e cria tenants e sites nas tabelas reais.

## IP do cliente

Vem do `RemoteAddr`. O `X-Forwarded-For` só é lido quando a conexão chega de um CIDR de `TRUSTED_PROXIES` (o Caddy na rede Docker, em produção); nesse caso o cliente é o primeiro endereço, da direita para a esquerda, que não é de um proxy confiável. O IP completo só existe na memória do request: o limite de taxa e o repasse usam o IP truncado.

## Privacidade (#24)

- **IP:** o Umami recebe só o IP truncado (último octeto do IPv4 zerado, IPv6 cortado em /48) e geolocaliza a partir dele. O IP completo não vai para banco, log nem cache.
- **Logs:** nenhum registro leva IP, `X-Forwarded-For` ou `User-Agent`. Um panic é tratado pelo próprio gateway, porque o `net/http` o registraria com o endereço do cliente.
- **Cookies:** nenhuma resposta grava cookie, e o `Cookie` que chega não é repassado ao Umami. O script não usa cookie nem storage (ver `packages/tracker`).
- **Dado pessoal:** o Umami guarda navegador, sistema, tipo de aparelho, tela, idioma e país, região e cidade do IP truncado. Nada disso identifica uma pessoa, então não há dado sujeito a apagamento.
- **Testes:** `privacy_test.go` (logs e cookies) e `e2e/privacy_test.go`. Este último manda IPs conhecidos pelo `X-Forwarded-For` e confere duas coisas: que o país da sessão no Umami saiu do IP truncado, e que nenhuma coluna de texto dos bancos `umami` e `stellytics` contém o IP completo.

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | obrigatória | Banco `stellytics` com o usuário `stellytics_ingest` |
| `UMAMI_URL` | obrigatória | Base do Umami na rede interna (ex.: `http://umami:3000`) |
| `LISTEN_ADDR` | `:8080` | Endereço HTTP |
| `CLIENT_IP_HEADER` | `x-stellytics-client-ip` | Header com o IP truncado; o serviço `umami` usa a mesma variável |
| `SCRIPT_DIR` | vazio (`/scripts` na imagem) | Pasta servida em `/s/`; vazia desliga a rota |
| `TRUSTED_PROXIES` | vazio | CIDRs ou IPs, separados por vírgula |
| `RATE_LIMIT` | `20` | Eventos por segundo por IP truncado |
| `RATE_BURST` | `40` | Rajada do token bucket |
| `SITE_CACHE_TTL` | `1m` (`5s` no Compose) | Cache das respostas da `ingest_site` |
| `SITE_STALE_TTL` | `0` (desligado) | Por quanto tempo uma resposta vencida da `ingest_site` ainda vale quando o banco falha (0 a 1h) |
| `PROOF_SECRET` | sorteada ao subir | Chave dos desafios, com 32+ caracteres. Defina em produção: a chave sorteada não vale entre reinícios nem entre réplicas |
| `PROOF_BITS` | `12` | Dificuldade da prova (0 a 24) |
| `PROOF_TTL` | `10m` | Validade de um desafio (1m a 1h) |
| `FINGERPRINT_LIMIT` | `50` | Fingerprints distintas por IP truncado e site na janela (0 a 1000; 0 desliga) |
| `FINGERPRINT_WINDOW` | `10m` | Janela deslizante das fingerprints (1m a 24h) |
| `RELAY_MAX_INFLIGHT` | `0` (desligado) | Máximo de repasses ao Umami ao mesmo tempo (0 a 100000); ver "Saturação do Umami" |
| `RELAY_QUEUE_WAIT` | `250ms` | Quanto um evento espera por uma vaga de repasse antes do descarte com `204` (0 a 10s; `0` recusa na hora) |

## Desenvolvimento

De dentro de `services/`:

```bash
go test -race ./ingest-web/...
```

O teste de integração do pacote `site` roda quando `DATABASE_URL` aponta para o banco `stellytics`. Ele precisa dos usuários de `infra/compose/postgres/init/02-ingest-roles.sh` e nunca aplica migrações no banco de `DATABASE_URL`: elas são do portal, que as registra no Drizzle. Com um usuário que pode criar bancos (o CI), o teste cria um banco temporário, aplica as migrações lá e o apaga no fim. Com o usuário `stellytics` do Compose, ele usa o banco já migrado pelo portal, ou é pulado se o portal ainda não subiu. Depois conecta como `stellytics_ingest`, com a senha `stellytics_ingest` ou pela URL de `INGEST_DATABASE_URL`.

O teste ponta a ponta precisa do ambiente do Compose no ar, com o Umami publicado pelo override de desenvolvimento (ele usa a API de administração do Umami):

```bash
docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d --build --wait
```

```bash
go test -tags e2e -count=1 ./ingest-web/e2e/...
```

Ele cria um website no Umami pela API (`admin`/`umami`) e um tenant ativo com esse site no banco `stellytics`. Depois manda page views ao gateway (porta 3002) e confere o que chega ao Umami. O `TestRecorderRecordsNothing` confere que gravação de sessão e heatmaps não gravam nada ([docs/umami.md](../../docs/umami.md)). O teste de privacidade precisa que o gateway confie no `X-Forwarded-For` do teste: suba o Compose com `INGEST_TRUSTED_PROXIES=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8`, como no CI. As URLs podem ser trocadas por `GATEWAY_URL`, `UMAMI_URL`, `STELLYTICS_DATABASE_URL` e `UMAMI_DATABASE_URL`.

A imagem (`Dockerfile`, contexto na raiz) é `scratch` com o binário e as versões publicadas do script, copiadas de `packages/tracker/published` quando a pasta existe. O healthcheck do contêiner é `ingest-web -healthcheck`.
