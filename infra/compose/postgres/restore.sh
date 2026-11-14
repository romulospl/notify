#!/bin/sh
# notify-restore (#14, ADR 0004): traz um backup do Object Storage para uma
# pasta de dados VAZIA e prepara a recuperação. Na próxima subida, o Postgres
# aplica o WAL arquivado e abre o banco.
#
#   notify-restore [BACKUP] [ALVO]
#   BACKUP: nome do backup base (padrão LATEST; `wal-g backup-list` mostra os nomes)
#   ALVO:   horário até onde recuperar, como '2026-11-14 10:00:00+00'
#           (padrão: até o último WAL arquivado)
#
# Passo a passo na VM em docs/deploy.md ("Restaurar o banco").
set -eu
: "${PGDATA:?}"
backup="${1:-LATEST}"
target="${2:-}"

if [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  echo "notify-restore: $PGDATA não está vazia; mova os dados atuais antes." >&2
  exit 1
fi

wal-g backup-fetch "$PGDATA" "$backup"
# O backup traz o postgresql.auto.conf da época: se ele veio de uma restauração
# anterior, tem um restore_command e talvez um recovery_target_* antigo, que
# faria esta restauração parar no horário errado. Tira tudo antes de escrever.
conf="$PGDATA/postgresql.auto.conf"
if [ -f "$conf" ]; then
  sed -i -E '/^[[:space:]]*(restore_command|recovery_target[a-z_]*)[[:space:]]*=/d' "$conf"
fi
{
  echo "restore_command = 'wal-g wal-fetch %f %p'"
  if [ -n "$target" ]; then
    echo "recovery_target_time = '$target'"
    echo "recovery_target_action = 'promote'"
  fi
} >> "$PGDATA/postgresql.auto.conf"
touch "$PGDATA/recovery.signal"
echo "notify-restore: backup $backup pronto em $PGDATA. Suba o Postgres para aplicar o WAL."
