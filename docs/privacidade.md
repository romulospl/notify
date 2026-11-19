# Privacidade e GDPR

Este documento descreve o que a plataforma faz com dados pessoais, lendo o código da `main`, e lista o que ainda não existe. Ele **não é parecer jurídico**: os papéis (controlador e operador) e os pontos de atenção por jurisdição são uma **proposta para validar com assessoria jurídica**, e o que não foi conferido está marcado como tal. Atende à issue [#40](https://github.com/romulospl/stellytics/issues/40).

Convenções: "verificado" quer dizer que a afirmação foi conferida no código ou na configuração citados ao lado. "Não verificado" quer dizer que depende de comportamento de terceiros (Umami, provedor de SMTP, provedor da VPS e do armazenamento S3) ou de algo que o repositório ainda não tem.

Seções verificadas diretamente no código: 3.1 (`tracker.ts`, `relay.go`), 3.3 (`auth.ts`, `schema.ts`) e 4 (`clientip.go`). As demais combinam código, specs e ADRs, como indicado em cada uma.

## 1. Resumo

- **Visitantes dos sites dos tenants (analytics web):** sem cookie, sem `localStorage`/`sessionStorage`, sem identificador persistente no navegador. O IP completo nunca é gravado: o gateway trunca antes de repassar ao Umami.
- **Chamadas de API dos tenants (analytics de API):** só contadores e histogramas por rota, método e status, a cada minuto. Traces, spans e logs são descartados.
- **Usuários do portal (e-mail, nome, senha com hash):** são dados pessoais e ficam no banco `stellytics`. O portal não grava o IP de quem entra.
- **Onde ficariam:** na região da VPS e do bucket S3 de backup que o operador escolher; essa escolha **ainda não foi feita** e a produção ainda não foi aplicada (`docs/andamento.md`).
- **Apagamento:** existe agora (#154), com três caminhos: o usuário exclui a própria conta em `/settings` (o projeto dele e os dados coletados saem junto); o operador SCF apaga os dados de um projeto removido; e a retenção automática apaga eventos web com mais de 183 dias (seção 6). O que não existe é apagar *os dados de um visitante específico* sem apagar o site inteiro: a seção 7 explica por quê.

## 2. Papéis (proposta a validar)

| Dado | Quem decide finalidade e meios (proposto) | Papel da plataforma (proposto) |
|---|---|---|
| Eventos de visitantes dos sites do tenant e métricas de API do tenant | O projeto (tenant), que instala o script ou o OpenTelemetry | **Operador** (processor) |
| Conta no portal (e-mail, nome, senha, sessões) | A própria plataforma | **Controlador** |
| `audit_log` e registros de operação (remoção de projeto, chaves) | A plataforma | **Controlador** |

Consequências a tratar com o jurídico, **não resolvidas aqui**: quem é a entidade legal que opera a instância (o repositório é código aberto; quem hospeda assume o papel), contrato de tratamento (DPA) com cada tenant, texto de aviso de privacidade do portal e orientação aos tenants sobre o aviso que eles devem dar aos próprios visitantes. Os operadores do SCF veem dados de todos os projetos (seção 5); a relação entre o SCF e cada tenant também precisa de definição.

## 3. O que é coletado e onde fica

### 3.1 Analytics web

O script `packages/tracker` envia um page view por carregamento (e por troca de rota em SPA) com estes campos (`packages/tracker/src/tracker.ts`): `website` (ID do site), `hostname`, `url` (caminho mais só os parâmetros `utm_*`; o resto da query string é descartado), `referrer` (origem e caminho, sem query nem fragmento; vazio se for a mesma página), `title`, `language` (`navigator.language`) e `screen` (largura x altura). Junto vai a prova de execução de JS, que o gateway não repassa.

O gateway (`services/ingest-web/internal/relay/relay.go`) remonta o payload só com esses campos e repassa ao Umami com o `User-Agent` original e o IP **já truncado** num header. Nunca repassa `ip`, `userAgent`, `id` nem `timestamp` vindos do cliente.

O Umami (v3.4.1, sem patch, `docs/umami.md`) grava os eventos no banco `umami`. O que o Umami cria a partir disso (sessão, navegador, sistema, dispositivo, país/região/cidade pela geolocalização do IP truncado) é **comportamento do Umami e não foi lido aqui**. Foi verificado apenas que o país da sessão sai do IP truncado e que o IP completo não aparece em nenhuma coluna de texto dos bancos `umami` e `stellytics` (`services/ingest-web/e2e/privacy_test.go`, roda no job `compose` do CI).

Dois pontos de atenção: o `url` e o `title` são dados que a página do tenant define. Um caminho como `/perfil/maria@exemplo.com` ou um título com nome próprio seriam gravados. O script já descarta a query string (exceto `utm_*`), mas o tenant deve evitar dado pessoal em caminhos e títulos.

### 3.2 Analytics de API

O coletor (`services/collector`) autentica pela chave de ingestão, grava o tenant da chave e ignora o que o cliente disser sobre isso. O exporter `stellyticspg` transforma spans de servidor HTTP e a métrica de duração em pontos por minuto na tabela `api_metric_1m`: tenant, serviço, rota normalizada, método, status, contagem, soma de durações e histograma (`docs/specs/e5-pipeline-de-api.md`, seção 4). Traces, spans e logs são descartados e não são gravados. Não há IP nem identificador de usuário final nas colunas.

Ponto de atenção: a rota é texto. Segmentos numéricos, UUIDs, endereços Stellar e hashes hex viram marcadores (`{id}`, `{uuid}`, `{address}`, `{hash}`), mas outro segmento que carregue dado pessoal (por exemplo `/users/maria`) seria gravado como veio, e um `http.route` enviado pelo cliente vale como veio. Mitigação parcial: teto de 500 rotas por serviço e dia, depois `{other}`.

### 3.3 Contas do portal

Tabelas `user`, `account`, `session` e `verification` (`apps/portal/src/lib/db/schema.ts`):

- `user`: nome, e-mail, papel e datas. `account`: senha com hash (Better Auth). `tenant_member`: vínculo do usuário com o projeto.
- `session`: token, expiração e **`user_agent`**. O `ip_address` é sempre nulo, porque o hook `databaseHooks.session.create.before` em `apps/portal/src/lib/auth.ts` o zera. Ou seja, o User-Agent de quem entra no portal **é gravado**; o IP não.
- `verification`: tokens de confirmação de e-mail e de redefinição de senha.
- O Better Auth usa um cookie de sessão no portal (necessário para o login). Sessão de 7 dias, renovada a cada dia de uso. Isso vale só para o portal, não para os sites dos tenants.
- O limite de tentativas por IP (`rateLimit` em `auth.ts`) é em memória, por instância. Se o Better Auth ou o Next.js registram o IP em log em algum ponto **não foi verificado**.

### 3.4 Registro de auditoria e chaves

`audit_log` recebe ação, quem fez (`actor_user_id`), tenant, data e `details` (`tenant.created`, `tenant.removed`, `tenant.reactivated`, `operator.created`, `ingest_key.created`, `ingest_key.revoked`, entre outras). O código e o comentário do esquema dizem que não leva chave, senha nem IP. O motivo da remoção de um projeto é texto livre digitado pelo operador e vai para `details` e também para `tenant.status_reason`; `tenant.status_changed_by` guarda o operador (chave estrangeira para `user` com `onDelete: set null`), ou seja, apagar o operador zera esse campo, mas não o `actor_user_id` do `audit_log`. A tabela só aceita inserção (gatilhos em `apps/portal/drizzle/0002_ingest_views.sql` e `0009_erasure.sql` contra UPDATE, DELETE e TRUNCATE) e não tem chave estrangeira, de propósito: sobrevive à exclusão do usuário ou do tenant.

**Exceção única (#154):** o gatilho de `0009_erasure.sql` aceita uma mudança e só ela — trocar um `actor_user_id` existente pelo marcador `[apagado]`, sem tocar nas outras colunas. É o que a exclusão de conta executa: as ações da pessoa continuam no histórico, mas deixam de apontar para ela, cuja linha saiu do banco. O teste de isolamento (`apps/portal/test/isolation.test.ts`) confere que qualquer outra mudança, DELETE e TRUNCATE continuam recusados e que o marcador do código é o mesmo do gatilho.

A chave de ingestão completa nunca é gravada; só o prefixo e o SHA-256 (`ingest_key`), e `last_used_on` guarda só a data.

### 3.5 E-mail

O portal envia por SMTP (`apps/portal/src/lib/mail.ts`, variável `SMTP_URL`) só duas mensagens, em texto puro: confirmação de e-mail e redefinição de senha. Em falha, o log leva só o tipo do erro, sem destinatário nem corpo. Qual provedor de SMTP será usado em produção **não está definido no repositório** (`.env.production.example` deixa `SMTP_URL` vazio). O provedor será um suboperador: precisa estar na região declarada (seção 6) ou ter garantias de transferência, e isso **não foi verificado**. Não há e-mail de marketing.

### 3.6 Logs e memória

- **Gateway:** nenhum log leva IP, `X-Forwarded-For` ou `User-Agent`; um panic é registrado com `path` e `fmt.Sprint(v)` (`handler.go`, `recoverPanic`), onde `v` é um valor arbitrário do panic: não leva IP por desenho, mas o conteúdo não é controlado. O nível do log é o padrão do `slog` (Info), então os logs `Debug` de "evento descartado" ficam desligados. Nenhuma resposta grava cookie. O limite de requisições por IP e a contagem de fingerprints (hash de User-Agent, `Accept-Language`, idioma e tela) usam o IP **truncado**, só em memória e por janela curta (`internal/limit`, `internal/fingerprint`).
- **Caddy:** não configura access log; os logs de erro saem no stderr do contêiner com IP, porta, cabeçalhos, URI e dados de TLS removidos pelo filtro do `infra/caddy/Caddyfile`. Logs globais do host podem seguir a configuração padrão do sistema.
- **Coletor:** quando a consulta à `ingest_key_active` falha, o log leva o prefixo da chave (`ingestkeyauth/auth.go`), que é a parte pública e não é dado pessoal; a chave completa não. Uma leitura de todos os logs do coletor **não foi feita**.
- **Portal:** o logger do Better Auth está em `warn` (`auth.ts`), e o envio de e-mail loga só o tipo do erro.
- **Contêineres:** em produção usam `json-file` com 20 MB por arquivo e 5 arquivos (`x-logging` em `infra/compose/prod.yaml`). A rotação é por tamanho, não por tempo, então não há prazo fixo de retenção dos logs. O conteúdo dos logs do Umami e do Postgres **não foi verificado**.

## 4. Truncamento de IP

`services/ingest-web/internal/clientip/clientip.go`, função `Truncate`: zera o último octeto do IPv4 (`203.0.113.77` vira `203.0.113.0`) e tudo depois do `/48` do IPv6; IPv4 mapeado em IPv6 é tratado como IPv4. Testado em `clientip_test.go`. O IP completo existe só na memória do request. O `X-Forwarded-For` só vale vindo de `TRUSTED_PROXIES` (o Caddy na rede Docker em produção). Limite honesto: um IPv4 truncado ainda identifica uma rede de até 256 endereços, e o `User-Agent` completo continua indo ao Umami. Se esse conjunto é "dado pessoal" depende da avaliação jurídica e do que o Umami grava (não verificado).

## 5. Quem acessa

- Cada tenant vê só os próprios dados; o tenant vem sempre da sessão (ADR 0003, suíte `apps/portal/test/isolation.test.ts`).
- O operador do SCF tem leitura global (painéis `/operator`, `/operator/web`, `/operator/api`) e hoje só escreve para remover e reativar projeto. Operadores nascem só por comando de administração, que grava no `audit_log`.
- O Umami fica só na rede interna: sem porta publicada e sem rota no Caddy (`docs/umami.md`, #62). Gravação de sessão e heatmaps estão desligados, e há teste (`TestRecorderRecordsNothing`).
- Quem administra a VPS e o banco por SSH também acessa tudo. Não há controle de acesso documentado além do túnel de administração (`docs/deploy.md`); processo de acesso e registro **não verificados**.

## 6. Residência dos dados e retenção

**Onde ficam** ([ADR 0016](adr/0016-producao-em-vps.md)): na região da VPS e do bucket S3 de backup que o operador escolher; o repositório não fixa provedor nem região. **Essa escolha ainda não foi feita** e a produção ainda não foi aplicada, então hoje nenhum dado de produção existe. O RFP exige declarar a residência: o operador precisa decidir e declarar a região (por exemplo, UE) antes de receber dados. Os backups do WAL-G saem da VPS **cifrados no cliente** (`WALG_LIBSODIUM_KEY`, guardada fora da VPS). O monitoramento externo (ADR 0005) roda num host separado, também escolhido pelo operador, e, pelo ADR, serve para checar disponibilidade; **não verifiquei** se algum dado de analytics chega a ele. Os provedores da VPS e do armazenamento S3 são suboperadores; contrato e localização do suporte deles **não verificados**.

**Quanto tempo ficam:**

| Dado | Retenção | Fonte |
|---|---|---|
| `api_metric_1m` | 35 dias, por `DROP` de partição mensal | migração `0005_api_metric_rollup.sql`, spec do E5 |
| `api_metric_1h`, `api_metric_1d` | 25 meses | idem |
| Eventos web no Umami | **183 dias, cerca de seis meses** (#154): o job de consolidação (`services/rollup`) apaga eventos e sessões mais antigos, com `UMAMI_DATABASE_URL` e `UMAMI_RETENTION_DAYS` | `services/rollup/main.go`, `docs/umami.md` |
| Conta, sessões, sites, chaves | Apagadas na exclusão da própria conta (`/settings`) ou no apagamento de projeto removido pelo operador (#154) | `src/lib/data/erasure.ts` |
| `audit_log` | Para sempre, **anonimizado** na exclusão da conta: `actor_user_id` vira `[apagado]`, única mudança que o gatilho aceita (migração `0009_erasure.sql`) | esquema |
| Backups | WAL-G: os `WALG_RETAIN_FULL` (padrão 7) backups base mais recentes mais o WAL contínuo entre eles, cifrados no cliente. Dados apagados continuam nos backups até saírem da janela | `infra/compose/postgres/backup.sh`, ADR 0016 |

O serviço de consolidação (`services/rollup`) e o coletor estão no `infra/compose/prod.yaml` desde 16/11/2026 (ADR 0012). A retenção de API descrita acima está implementada e testada, mas nenhuma produção real foi aplicada ainda. O vhost Caddy não configura access log e registra apenas erros críticos; assim, os cabeçalhos, inclusive a chave de ingestão (`Authorization`), não são escritos pelo proxy.

## 7. Direito ao apagamento e outros direitos

A issue pede a justificativa para não haver fluxo de apagamento por "nenhum dado pessoal guardado". Depois de ler o código, a frase só vale em parte, e o documento não promete mais do que isso. **A partir de 17/11/2026 os fluxos abaixo existem** (issue #154); o que continua em aberto está marcado.

**Visitantes dos sites (analytics web):**

- O navegador não guarda identificador (sem cookie ou storage), o gateway não repassa `id` do cliente e o IP completo não é gravado. **Como o Umami 3.4.1 deriva o `session_id` (conferido no código-fonte da versão, tag `v3.4.1`, `src/app/api/send/route.ts` e `src/lib/crypto.ts`):** `uuid5(sha512(website_id, ip, user_agent, sal, distinct_id, APP_SECRET))`, em que o `ip` é o já truncado e o sal rotaciona por mês (`SALT_ROTATION`, padrão `month`). Ou seja: é um pseudônimo **derivado de IP truncado mais User-Agent**, cifrado com o segredo do servidor — não é identificador anônimo, e um conjunto de IP truncado mais User-Agent provavelmente é dado pessoal. Não há `distinct_id` aqui: o gateway nunca repassa o `id` do cliente.
- Consequência prática para apagamento individual: **não há como mapear o pedido de um visitante ("apague meus dados") para linhas do banco**, porque nem o tenant nem a plataforma sabem qual `session_id` é daquela pessoa (a menos que ela mesma identifique, o que não acontece). Os caminhos de apagamento que valem:
  1. **Retenção automática:** eventos e sessões saem depois de 183 dias (`services/rollup`, `docs/umami.md`).
  2. **Apagar o site inteiro:** na remoção do projeto pelo operador ou na exclusão da conta do dono, todos os sites saem do Umami (`DELETE /api/websites/:id`) com tudo que coletaram.
  3. **Um visitante específico**, no improbável caso de ele apresentar seu `session_id` ou um recorte identificável: procedimento manual de quem administra o banco (`DELETE` em `website_event`/`session` por `session_id`); sem tela e sem processo automático — registrado no checklist da seção 9.
- Arquivar um site (`site.archived_at`) para a ingestão e tira o site dos painéis; apagar os dados coletados é o fluxo de apagamento de projeto, que remove o site do Umami inteiro.

**Usuários do portal (controlador: a plataforma):**

- **Exclusão da própria conta existe:** página `/settings` do portal, com confirmação pelo e-mail digitado (`src/app/(private)/settings/`). Ela apaga, na ordem: os sites no Umami do projeto (se o usuário é dono dele), linhas de site/serviço/chave, as métricas de API (`api_metric_purge_tenant`, migração `0009`), as chaves de leitura do SCF criadas pelo usuário, e por fim a linha do usuário — sessão, senha e vínculo saem em cascata. O projeto fica no banco como `removed`, sem dados, e o histórico dele continua legível.
- **Audit_log:** todas as ações do usuário (`tenant.purged`, a própria `account.deleted` e as anteriores) recebem `actor_user_id = [apagado]`, a única mudança que o gatilho aceita. O `status_changed_by` do projeto vira nulo por chave estrangeira.
- **Retificação (mudar nome ou e-mail), portabilidade, limitação e oposição: continuam sem tela nem processo.** O pedido hoje é atendido à mão por quem administra o banco; processo documentado de pedidos de titulares continua no checklist (seção 9, item 7).
- **Um pedido de correção de dado no `audit_log`** continua impossível por desenho: o gatilho aceita só a troca do `actor_user_id` pelo marcador.

**Operador SCF:** página do projeto, em `/operator/tenants/[id]`, tem "Erase project data" para projetos `removed` (não vale para ativo nem pendente), com confirmação pelo slug digitado. A ação é a mesma da exclusão de conta, sem apagar o usuário.

**Limites conhecidos dos fluxos:**

- **Backups:** dados apagados continuam nos backups até saírem da janela (`WALG_RETAIN_FULL`, seção 6). A restauração volta o que estava na hora alvo; não há "apagar também nos backups".
- **Concorrência:** os sites saem do Umami antes do banco; se a parte do banco falhar, repetir a operação completa (o DELETE no Umami trata 404 como sucesso). Eventos que chegarem entre o DELETE do site e a conclusão são apagados pelo Umami junto com o site.
- **Projetos com mais de um membro:** hoje não há convites e cada usuário pertence a um projeto único; a exclusão da conta do dono apaga o projeto dele. Se convites forem implementados, a regra precisa de revisão.

## 8. Jurisdições: lista provisória (proposta)

A issue pede a lista de jurisdições onde a solução não seria conforme sem opt-in. **Este critério é atendido só parcialmente:** não há conclusão jurídica no repositório, e este documento não a inventa. Abaixo está uma lista **provisória, para validar com assessoria jurídica**, que separa onde há regime próprio de consentimento para acesso ao dispositivo (que é o ponto de partida da dúvida) do que não foi analisado.

O que o código faz, verificado: o script não escreve nem lê cookie, `localStorage` ou `sessionStorage` e não guarda identificador no navegador (`packages/tracker/src/tracker.ts`). Ele lê `navigator.language`, `screen`, `document.title` e `document.referrer` e os envia.

**A rever primeiro (regime de consentimento para acesso ao dispositivo, conclusão em aberto):**

| Jurisdição | Ponto a revisar |
|---|---|
| UE/EEE (GDPR e diretiva ePrivacy, art. 5(3)) | Se ler `language` e `screen` e enviar IP truncado e `User-Agent` ao Umami exige consentimento ou base legal. **Em aberto** |
| Alemanha (TDDDG, antes TTDSG) e França (orientação da CNIL sobre medição de audiência) | Orientações próprias, com condições para dispensar consentimento. As condições (como limite de retenção) **não foram conferidas aqui**; a retenção dos eventos do Umami (183 dias, seção 6) já está implementada, mas a lista completa de condições **não foi conferida contra ela** |
| Reino Unido (UK GDPR e PECR) | Regime análogo, com orientações do ICO; **não verificado** |

**Não analisadas** (podem ter regras próprias de privacidade ou de consentimento): Brasil (LGPD), Califórnia (CCPA/CPRA), Suíça e demais jurisdições. Aplicação e enquadramento, inclusive o fato de o código não enviar dados a terceiros de publicidade (verificado só no gateway e no portal), não substituem essa análise.

Não há base no repositório para concluir, para nenhum dos lados, se o consentimento é ou não exigido. Cada tenant que instala o script decide se mostra aviso ou banner; este projeto não oferece opt-in.

Não há transferência para fora da região da VPS por parte do código: o gateway só fala com o Umami interno. Tenants em outra jurisdição enviam dados de visitantes para a região que o operador escolher (seção 6); isso, e qualquer transferência por suboperadores (SMTP, backup), precisa de análise.

## 9. Checklist do que verificar com assessoria jurídica

1. Entidade legal operadora, papéis da seção 2 e DPA com tenants (e com o SCF).
2. Qualificação de IP truncado (/24, /48) mais User-Agent como dado pessoal ou não.
3. Necessidade de consentimento por jurisdição (seção 8).
4. ~~Retenção dos eventos do Umami e conclusão sobre `audit_log` permanente.~~ Implementados (#154): 183 dias nos eventos (`docs/umami.md`) e `audit_log` anonimizado na exclusão de conta (seções 3.4 e 7). **Falta** a validação jurídica do prazo de 183 dias e do marcador.
5. Suboperadores: provedores da VPS e do armazenamento S3 (a escolher), provedor de SMTP e, se houver, o do monitoramento.
6. Aviso de privacidade do portal e texto-modelo para os tenants.
7. Processo de pedidos de titulares: **continua em aberto** — apagamento automático existe (seção 7), mas não há processo documentado para pedidos individuais (retificação, portabilidade, um visitante específico).
8. Como o Umami deriva e persiste o `session_id` e os demais campos da sessão (IP truncado, `User-Agent`, sal), e se isso permite ou dispensa um fluxo de apagamento de visitantes. **Derivação conferida no código-fonte da v3.4.1** (seção 7): `uuid5(sha512(website_id, ip, user_agent, sal, distinct_id, APP_SECRET))`, sal rotativo mensal. **Falta** a conclusão jurídica sobre o conjunto.
9. Gatilho de `audit_log` e pedidos de correção ou apagamento (seção 3.4): **parcialmente resolvido** — a única mudança aceita é a anonimização na exclusão de conta; correção de conteúdo continua impossível por desenho.

## 10. Arquivos conferidos

`services/ingest-web/internal/clientip/clientip.go`, `services/ingest-web/internal/relay/relay.go`, `services/ingest-web/internal/fingerprint/fingerprint.go`, `services/ingest-web/handler.go`, `services/ingest-web/main.go` (logs), `services/ingest-web/e2e/privacy_test.go` (lido o cabeçalho e o teste de IP), `packages/tracker/src/tracker.ts`, `apps/portal/src/lib/auth.ts`, `apps/portal/src/lib/mail.ts`, `apps/portal/src/lib/db/schema.ts`, `apps/portal/src/lib/data/operator/tenants.ts`, `apps/portal/src/lib/data/erasure.ts`, `apps/portal/src/app/(private)/settings/`, `infra/caddy/Caddyfile`, `infra/compose/prod.yaml` (lista de serviços), `docs/adr/0004-hospedagem-e-backup.md`, `docs/umami.md`, `docs/specs/e5-pipeline-de-api.md` e `docs/specs/e2-tenants-e-controle-de-acesso.md` (trechos sobre retenção e remoção). Em 17/11/2026 (#154): o código-fonte do Umami 3.4.1 (`src/app/api/send/route.ts`, `src/lib/crypto.ts`, `src/queries/sql/sessions/createSession.ts`, tag `v3.4.1`) para a derivação do `session_id`, e o schema do banco `umami` (tabelas `session` e `website_event`, conferidas num banco da versão).

**Não lidos nem testados:** o código do Umami além da derivação do `session_id` (como grava eventos e a geolocalização), as migrações `0002` e `0005` em SQL (só os resumos do `CLAUDE.md` e dos specs), o código completo do coletor e do exporter, logs reais de execução, a configuração real do SMTP e do monitoramento.
