# Runbook: resposta a vulnerabilidades

Política pública, prazos e escopo em [`SECURITY.md`](../../SECURITY.md): relato privado pela aba **Security** do GitHub (**Report a vulnerability**), confirmação em até 3 dias úteis, avaliação de possíveis críticas e altas em até 48 horas (demais em 7 dias), correção em até 7 dias corridos (crítica), 14 (alta) e 90 (média ou baixa), desde o recebimento ou identificação. Contenção de críticas em 72 h é meta. Severidade por CVSS 3.1. Contexto de cadeia de suprimentos: [`docs/anti-bot-e-cadeia-de-suprimentos.md`](../anti-bot-e-cadeia-de-suprimentos.md).

## Sintomas

Um relato privado chegou; um scanner ou o Renovate apontou dependência vulnerável; um tenant diz que uma chave de ingestão vazou; suspeita de dados de um tenant vistos por outro; um operador ou uma conta foi comprometido.

## 1. Receber e avaliar

1. Confirme o recebimento no próprio relato (até 3 dias úteis). Não discuta em issue pública.
2. Reproduza num ambiente local (`docker compose up -d --wait`). Classifique pelo CVSS 3.1 e registre o prazo de `SECURITY.md`.
3. Alta prioridade, segundo o `SECURITY.md`: leitura de dados de outro tenant, burla da chave de ingestão, persistência de dado pessoal (IP completo) e inflação de métricas. Para isolamento, procure o caso em `apps/portal/test/isolation.test.ts` e em `services/collector/e2e/isolation_test.go`; a correção precisa deixar um teste novo ali.
4. Verifique se houve exploração: `audit_log` (ações `ingest_key.created`, `ingest_key.revoked`, `tenant.removed`, `operator.*`) pelo túnel (`infra/scripts/admin-tunnel.sh`):

   ```bash
   psql 'postgresql://stellytics:<STELLYTICS_DB_PASSWORD>@127.0.0.1:15432/stellytics' \
     -c "select at, action, actor_user_id, tenant_id from audit_log order by at desc limit 50"
   ```

   (colunas conferidas em `apps/portal/src/lib/db/schema.ts`; a consulta em si não foi executada). Os logs dos serviços não têm IP nem cabeçalhos dos visitantes, então a exploração de fora costuma não deixar rastro ali.

## 2. Conter

Escolha o que se aplica; todas têm efeito imediato ou em até 1 minuto na ingestão (cache de `ingest_site` do gateway: no máximo 1 minuto; da chave no coletor: no máximo 60 s).

### Chave de ingestão vazada

O próprio tenant revoga em `/services` (a ação grava `ingest_key.revoked`). O coletor passa a recusar com 401. Quem cria a chave nova é o tenant; a completa só aparece na criação. Se o tenant não conseguir, o operador não revoga pela tela (as únicas escritas do operador são remover e reativar projeto): use a remoção do projeto abaixo ou, pelo túnel, o SQL abaixo como usuário `stellytics` (dono das tabelas; é o papel que o portal usa para as mesmas escritas; **não testado**). Troque `<prefixo>` (8 caracteres, parte pública da chave `ntf_<prefixo>_...`); nunca ponha a chave completa em issue, log ou mensagem:

```sql
BEGIN;
UPDATE ingest_key SET revoked_at = now() WHERE prefix = '<prefixo>' AND revoked_at IS NULL;
-- Confira "UPDATE 1". Se vier UPDATE 0, faça ROLLBACK e investigue.
INSERT INTO audit_log (actor_user_id, action, tenant_id, details)
SELECT NULL, 'ingest_key.revoked', tenant_id,
       jsonb_build_object('apiServiceId', api_service_id, 'prefix', prefix, 'manual', true)
FROM ingest_key WHERE prefix = '<prefixo>';
COMMIT;
```

O `audit_log` só aceita inserção (gatilho contra UPDATE e DELETE), então um erro no INSERT não se corrige depois: confira antes de `COMMIT`. O `actor_user_id` fica nulo porque a ação é manual; registre por escrito quem fez.

### Projeto (tenant) a bloquear

Entre como operador em `/operator`, abra `/operator/tenants/<tenantId>` e use a remoção do projeto (motivo obrigatório; grava `tenant.removed` no `audit_log`). Efeito: as visões `ingest_site` e `ingest_key_active` exigem tenant `active`, então o gateway passa a descartar eventos (cache de até 1 minuto) e as chaves deixam de valer; o painel do tenant some. A reativação é a mesma tela (`tenant.reactivated`). Nenhum dado é apagado.

### Operador comprometido

Roda na **máquina do administrador**, num checkout do repositório com `pnpm install` e Node 24 (não na VPS, que tem o checkout mas não o Node nem o pnpm), com o túnel `infra/scripts/admin-tunnel.sh` aberto:

```bash
DATABASE_URL='postgresql://stellytics:<STELLYTICS_DB_PASSWORD>@127.0.0.1:15432/stellytics' \
  pnpm --filter @stellytics/portal operator:demote --email <e-mail>
```

Isso rebaixa a conta a usuário comum, apaga as sessões dela e grava `operator.demoted` no `audit_log`. **Limites:** não cobre conta de tenant comprometida (para isso, remova ou revise o projeto e use a recuperação de senha); e não impede uma nova promoção por quem tenha acesso ao banco (`operator:promote` com o mesmo `DATABASE_URL`): se o atacante tem o banco ou a VPS, o problema é de infraestrutura. Troque a senha da conta pelo fluxo de recuperação do portal se ela ainda for legítima e revise o `audit_log` pelas ações do operador. Se o vazamento foi do acesso ao servidor, siga [rotação de segredos](rotacao-de-segredos.md) por inteiro.

### Segredo ou acesso à infraestrutura vazado

[Rotação de segredos](rotacao-de-segredos.md). Para a VPS, troque a chave SSH e, se houver dúvida, recrie a VPS (`init.sh` e `deploy.sh`, `docs/deploy.md`) com segredos novos, levando os dados de `STELLYTICS_DATA_DIR` ou restaurando o backup ([backup e restauração](backup-e-restauracao.md)).

### Script de rastreamento adulterado ou com falha

Versões publicadas são imutáveis (`packages/tracker/published/vX.Y.Z/n.js`, hash em `published/sri.json`). A correção normal sai numa versão nova: suba a `version` do `package.json` e rode `pnpm --filter @stellytics/tracker release`; avise os tenants para trocar a URL e o SRI (trechos em `examples/README.md`).

**Retirar uma versão vulnerável não é só apagar a pasta.** Remover `published/vX.Y.Z/` quebra `packages/tracker/test/published.test.ts` (que exige uma entrada em `sri.json` para cada pasta e vice-versa, e confere o hash) e contraria a regra de imutabilidade. Para retirar de fato seria preciso, no mesmo PR: apagar a pasta, remover a entrada de `sri.json`, e registrar a exceção à política (ADR novo ou nota em `docs/anti-bot-e-cadeia-de-suprimentos.md`), e fazer deploy de imagem nova do `ingest-web` (a imagem copia `published/` para `/scripts`). Isso quebra os tenants que não migrarem (o script some, sem aviso). Alternativa a avaliar, **inexistente hoje**: o gateway responder `410 Gone` para uma lista de versões revogadas, sem apagar o arquivo do repositório; exigiria código e teste novos em `services/ingest-web`. Nada disto foi testado.

## 3. Corrigir e publicar

1. Corrija em branch privada ou num fork de segurança do GitHub (aba **Security**, advisory privado), com teste que falhava antes.
2. PR com commit em inglês, Conventional Commits (`fix(...)`). O CI (`ci`) precisa passar.
3. Publique uma **release** (`vX.Y.Z`): o `release.yml` gera o SBOM e publica no GHCR as imagens assinadas com cosign (keyless) com atestado do SBOM.
4. Deploy: atualize o checkout na VPS e rode `sudo ./deploy.sh`, que por padrão constrói as imagens a partir do código do checkout. As imagens assinadas da release podem ser usadas por digest (`PORTAL_IMAGE` etc. no `.env.production`), mas **nada confere a assinatura automaticamente** no deploy; é um controle mais fraco do que verificar a assinatura antes de subir. Antes, `systemctl start stellytics-backup` se a versão tiver migração. Pormenores: `docs/deploy.md`, "Atualizar a aplicação".
5. Dependência vulnerável: confira a correção upstream e siga a exceção abaixo quando a versão tiver menos de 14 dias. O Renovate ainda não está instalado e os alertas do GitHub precisam estar ativos; não dependa dele para detectar a vulnerabilidade. Para o Umami, ver [atualização do Umami](atualizacao-do-umami.md).

### Exceção à espera de 14 dias

Para vulnerabilidade crítica ou alta confirmada, o mantenedor pode usar uma versão de correção antes dos 14 dias quando esperar trouxer risco maior. Registre no advisory privado ou PR o identificador da vulnerabilidade, impacto e alcance, pacote e versão exatos, data da publicação, avaliação de procedência e integridade, motivo da exceção, responsável e data de retirada. A revisão, os testes, o CI e a assinatura da release continuam necessários. Sem correção upstream, contenha e comunique o risco; não classifique contenção como correção.

Para pacote pnpm, adicione temporariamente ao `pnpm-workspace.yaml` uma entrada `minimumReleaseAgeExclude` com **nome e versão exata** (por exemplo `pacote@1.2.3`), atualize o lockfile e revise o diff. Não desligue a espera globalmente nem exclua todas as versões de um pacote. Remova a entrada depois que a versão atingir 14 dias e confirme o CI. Para Go e imagens, atualize somente a versão corrigida e, em imagens, fixe tag e digest; registre a mesma justificativa no PR. Se a correção exigir várias dependências jovens, registre e avalie cada exceção.

O [Renovate](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts) pode levantar PRs de alertas de segurança sem a espera, mas depende do aplicativo e dos alertas do GitHub; no estado atual não está instalado. O pnpm mantém seu próprio controle de idade, mesmo quando o Renovate propõe uma atualização; veja [`minimumReleaseAgeExclude` no pnpm 10](https://pnpm.io/10.x/settings#minimumreleaseageexclude).

## 4. Verificar

- O teste que reproduzia o problema passa; a suíte de isolamento passa (`pnpm --filter @stellytics/portal test` e o job `compose` do CI).
- Passo 3 ("Check production") de `docs/deploy.md` na produção; a versão no ar é a do commit corrigido.
- A medida de contenção foi desfeita só quando a correção está no ar (reativar projeto, se for o caso).

## 5. Divulgar

Depois da correção publicada, publique o advisory do GitHub e dê crédito a quem relatou, se a pessoa quiser (`SECURITY.md`). Se dados pessoais de tenants ou visitantes foram expostos, os papéis (controlador e operador) estão na seção 2 de [`docs/privacidade.md`](../privacidade.md), e as lacunas jurídicas, nas seções 7 e 9; o procedimento de notificação de incidente de dados **não está escrito** em lugar nenhum do repositório: defina com o jurídico antes do primeiro incidente real).

## Quando escalar

- Severidade crítica ou alta, inclusive exposição de dados entre tenants: trate como incidente de imediato; conter em até 72 h quando possível; correção em até 7 dias corridos (crítica) ou 14 (alta) desde o recebimento ou identificação.
- Prazo do `SECURITY.md` em risco, ou vulnerabilidade na própria infraestrutura do provedor, no Umami, no Caddy ou no Postgres: reporte ao projeto de origem e ao suporte do provedor. Para parar o proxy principal use `docker compose -f prod.yaml stop caddy`; para os demais serviços use `docker compose -f prod.yaml stop <serviço>`. Parar o `ingest-web` descarta os eventos recebidos nesse intervalo.

## Não testado

Nada disto foi exercitado: nem uma revogação ou remoção em produção, nem o `operator:demote` contra o banco da VPS, nem a release com imagens assinadas (ainda não há release publicada), nem a retirada de uma versão do script.
