# Runbook: atualização do Umami

O Umami é a ferramenta base ([ADR 0001](../adr/0001-ferramenta-base.md)) e roda **sem patch**, fixado por tag e digest. Regras: [`docs/umami.md`](../umami.md) e o `CLAUDE.md` (versão só sobe por PR, com release de pelo menos duas semanas, sem fork pesado).

## Sintomas (quando usar)

- O Renovate abriu um PR para `ghcr.io/umami-software/umami` (regra própria em [`renovate.json`](../../renovate.json): sem agrupamento nem automerge, rótulos `dependencies` e `umami`; versão maior só depois de aprovada no Dependency Dashboard).
- Aviso de segurança do Umami, ou necessidade de uma correção que só existe na versão nova.

## Diagnóstico (decidir se atualiza)

1. A release tem pelo menos 14 dias? O Renovate espera (`minimumReleaseAge`); em correção de segurança urgente, a exceção é uma decisão registrada no PR, não automática.
2. Leia as notas da release procurando: migração de banco, mudança em `/api/send`, `/api/websites/:id/...` (`stats`, `pageviews`, `metrics`), no recorder (`/api/record`, colunas `recorder_enabled` e `replay_config`, tabelas `session_replay`, `session_replay_saved` e `heatmap_event`) e em variáveis de ambiente.
3. O Umami aparece em `infra/compose/dev.yaml` e `prod.yaml` (imagem por digest) e na regra própria do `renovate.json`. Procure todas as menções da versão atual: `grep -rn '3.4.1' docs/ CLAUDE.md infra/ apps/ services/ packages/ examples/ renovate.json` (ajuste o número) e atualize textos e testes que citem a versão.

## Ação

1. No PR (ou numa branch sua), troque tag e digest nos dois arquivos de Compose. Se o patch for necessário, ele entra documentado em `docs/umami.md`, com motivo e como reaplicar; evite.
2. Rode no ambiente local (`docker compose up -d --wait`, com o override `-f compose.yaml -f infra/compose/umami-port.yaml` quando precisar da interface):
   - `pnpm --filter @stellytics/portal test` (o Umami do portal é falso; testa o contrato do cliente);
   - o e2e do gateway (`services/ingest-web/e2e/`, que cobre inclusive `TestRecorderRecordsNothing`) e os de `examples/e2e`: o job `compose` do CI roda todos contra o Umami real, e é o que decide;
   - o teste de isolamento do portal (`apps/portal/test/isolation.test.ts`) e o do coletor/ingestão que o CI já executa.
3. Se o painel usa uma resposta nova do Umami (`/stats`, `/pageviews`, `/metrics`), compare a forma na versão nova com `apps/portal/src/lib/umami/` e com o Umami falso (`apps/portal/test/fake-umami.ts`); lembre que no `/metrics` do 3.4.1 o `y` conta visitantes.
4. Confira `docs/umami.md` (recorder desligado, porta fechada) e ajuste nomes que mudaram.
5. Deploy: o PR passa pelo CI inteiro (`ci` agregador, incluindo `infra`) e é mesclado por revisão humana. Na produção, depois de mesclado, atualize o checkout na VPS e rode `sudo ./deploy.sh`. **Antes**, force um backup base (`systemctl start stellytics-backup`), porque o Umami migra o próprio banco ao subir e a migração só anda para frente (`docs/deploy.md`, "Voltar atrás").

## Verificação

- `docker compose -f prod.yaml ps` com `umami` `healthy` (o healthcheck chama `/api/heartbeat`); `docker compose -f prod.yaml logs --tail 100 umami` sem erro de migração.
- O Umami continua fechado: o passo 3 ("Check production") de `docs/deploy.md` (`/api/send` com 404 de fora; o Caddy não tem rota para o Umami).
- Um evento de teste chega pelo gateway e aparece no painel do site; o painel do SCF (`/operator/web`) carrega.
- Isolamento: o tenant A não vê site de B (a suíte `isolation.test.ts` passou no CI da versão nova).
- `docs/umami.md`, o `CLAUDE.md` e os demais textos de versão (resultado do `grep`) refletem a versão nova. **Não reescreva o ADR 0001 só por causa da versão**; um ADR novo só se a decisão mudar (por exemplo, troca de ferramenta ou patch).

## Rollback

Voltar o digest do Umami sem restaurar o banco só funciona se a versão nova não migrou o esquema. Se migrou, restaure o backup feito antes ([backup e restauração](backup-e-restauracao.md)) e só então suba o digest antigo.

## Quando escalar

- A migração do Umami falha na subida e o banco não abre: restaurar o backup preventivo.
- A versão nova muda o contrato de forma incompatível: não atualize; registre no PR e acompanhe a próxima versão. Se a versão atual tiver falha de segurança sem correção compatível, trate como [vulnerabilidade](vulnerabilidades.md).

## Não testado

Nenhuma atualização do Umami foi feita em produção; o Renovate ainda não abriu esse PR contra este repositório (a versão em uso é a 3.4.1, a 3.5.x é adiada de propósito, ver ADR 0001).
