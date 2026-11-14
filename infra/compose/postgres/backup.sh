#!/bin/sh
# notify-backup (#14, ADR 0004): backup base do Postgres no Object Storage e
# limpeza dos antigos. O WAL vai continuamente pelo archive_command; o backup
# base dá o ponto de partida da restauração. Roda uma vez por dia na VM:
#   docker compose -f prod.yaml exec -T -u postgres postgres notify-backup
# Mantém os WALG_RETAIN_FULL (padrão 7) backups mais novos e o WAL entre eles.
set -eu
: "${PGDATA:?}"
wal-g backup-push "$PGDATA"
wal-g delete retain FULL "${WALG_RETAIN_FULL:-7}" --confirm
wal-g backup-list
