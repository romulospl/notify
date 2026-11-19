# Runbook: backup e restauração

A descrição completa (WAL contínuo, backup diário às 03:00 UTC pelo `stellytics-backup.timer` que o `deploy.sh` instala, retenção de `WALG_RETAIN_FULL` (padrão 7), passo a passo da restauração e voltar a um horário) está em [`docs/deploy.md`](../deploy.md), seções "Backup" e "Restore the database", e a decisão no [ADR 0016](../adr/0016-producao-em-vps.md). **Não repita os blocos de comandos daqui: use os de lá.** Este runbook diz quando acionar, como diagnosticar e como conferir.

Os scripts ficam em [`infra/compose/postgres/`](../../infra/compose/postgres/): `backup.sh` vira `stellytics-backup` e `restore.sh` vira `stellytics-restore` dentro da imagem do Postgres (`Dockerfile`).

## Sintomas

- Não há backup recente em `backup-list`, ou o `stellytics-backup.service` falhou.
- O arquivamento de WAL parou (o `archive_command` falha e o disco do Postgres enche com WAL pendente).
- Perda ou corrupção de dados, ou da VPS e do disco (restauração necessária).
- Antes de uma atualização com migração nova (backup preventivo).

## Diagnóstico

Na VPS, na pasta do checkout:

```bash
systemctl status stellytics-backup.service stellytics-backup.timer
systemctl list-timers stellytics-backup.timer
journalctl -u stellytics-backup.service -n 100 --no-pager
docker compose -f prod.yaml exec -u postgres postgres wal-g backup-list
docker compose -f prod.yaml exec -u postgres postgres wal-g backup-list --detail
docker compose -f prod.yaml logs --tail 200 postgres | grep -i -E 'archive|wal-g'
docker compose -f prod.yaml exec -u postgres postgres psql -c 'select * from pg_stat_archiver'
df -h /srv/stellytics   # STELLYTICS_DATA_DIR
```

Causas comuns: credencial do armazenamento S3 inválida ou expirada (`WALG_S3_ACCESS_KEY` e `WALG_S3_SECRET_KEY` no `.env.production`), endpoint, região ou prefixo errados (`WALG_S3_ENDPOINT`, `WALG_S3_REGION`, `WALG_S3_PREFIX`), bucket removido, rede, `WALG_LIBSODIUM_KEY` diferente da usada nos backups antigos (ver "Chave de cifra" abaixo), disco cheio.

## Ação

- **Backup base agora:** `systemctl start stellytics-backup` (executa `stellytics-backup`: `wal-g backup-push`, depois `wal-g delete retain FULL "$WALG_RETAIN_FULL" --confirm` e `backup-list`).
- **Credencial trocada:** siga [rotação de segredos](rotacao-de-segredos.md) e confira com `backup-list`.
- **Restaurar:** siga "Restore the database" em `docs/deploy.md`. Atenção: ela derruba portal, ingestão (eventos descartados) e Umami até terminar; exige `systemctl stop stellytics-backup.timer` antes (e `start` depois) e espaço livre para dois conjuntos de dados (`df -h /srv/stellytics`), porque os dados antigos ficam em `postgres.antes-*`. Siga também a janela de manutenção, o `mv` dos dados antigos para `postgres.antes-*` e o "voltar a um horário" (`stellytics-restore <backup> '<horário>'`). Para escolher entre restaurar o último ou um horário: um erro lógico (migração ruim, remoção indevida) pede o horário anterior ao erro, com um backup base concluído antes dele; perda de disco pede o `LATEST`.
- **Perda da VPS e do disco de dados:** prepare uma VPS nova com `init.sh` e `deploy.sh` ([`docs/deploy.md`](../deploy.md)) usando o **mesmo** `.env.production` (em especial `WALG_LIBSODIUM_KEY` e as credenciais do bucket) e restaure em seguida. Os backups sobrevivem enquanto o bucket existir; nada no repositório impede que ele seja apagado no provedor.

## Chave de cifra

Os backups são cifrados no cliente com `WALG_LIBSODIUM_KEY` (libsodium, 64 hexadecimais). **Sem essa chave não há como ler nenhum backup, e ela não pode ser trocada por rotina**: o `docs/deploy.md` é explícito, e o `prod.yaml` tem uma chave só, então um restore de backup antigo exige a chave antiga. Guarde uma cópia do `.env.production` no cofre de senhas, fora da VPS e do repositório.

Se a chave **vazar**, a resposta (ainda **não testada**) é: criar um bucket ou prefixo novo (`WALG_S3_PREFIX`), gerar uma chave nova, aplicar (`deploy.sh`) e rodar `systemctl start stellytics-backup` para um backup base novo, e **manter o prefixo antigo, com a chave antiga guardada**, enquanto houver retenção útil nele. Quem tiver a chave vazada e acesso ao bucket antigo lê esses backups: restrinja as credenciais do bucket antigo ([rotação](rotacao-de-segredos.md)).

## Verificação

- `wal-g backup-list` mostra um backup recente (data de hoje depois de `stellytics-backup`).
- `pg_stat_archiver` com `last_archived_time` de poucos minutos e `failed_count` sem crescer.
- Depois de uma restauração: `docker compose -f prod.yaml ps` todo `healthy`, os checks do passo 3 ("Check production") de `docs/deploy.md`, entrar no portal e abrir o painel de um site, e um novo `systemctl start stellytics-backup`. Só apague `postgres.antes-*` depois disso.
- **Ensaio:** a restauração é testada em todo PR pelo job `infra` do CI (`infra/compose/test/prod-stack-test.sh`, com S3 local). Contra o bucket real, ensaie numa VPS descartável antes de precisar (pendência registrada em `docs/deploy.md`); marque aqui a data do primeiro ensaio: **nunca realizado**.

## Quando escalar

- `backup-list` vazio ou sem backup novo por mais de 2 dias e a causa não é credencial ou rede.
- O Postgres não abre depois da restauração (log do contêiner `postgres`).
- Suporte do provedor para o armazenamento S3 fora do ar ou disco corrompido.
- Perda da `WALG_LIBSODIUM_KEY` (ou vazamento dela: ver "Chave de cifra"): os backups não são recuperáveis; trate como perda total de histórico.

## Não testado

Restauração contra um bucket S3 real, o `journalctl` e as units numa VPS real, o `pg_stat_archiver` no ambiente de produção e a troca da chave de cifra.
