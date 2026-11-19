#!/usr/bin/env bash
# Exporta os bancos stellytics e umami para uma pasta (#54, docs/transferencia.md).
#
# Gera stellytics.dump e umami.dump (formato custom do pg_dump, compactado), a
# impressão digital da origem (fingerprint.txt) e sha256sums. Rode na VM de
# origem como root, na raiz do clone, na janela de manutenção e
# com o portal, o gateway e o Umami parados (senão os dois bancos podem ficar
# em instantes diferentes):
#
#   docker compose --env-file .env.production -f infra/compose/prod.yaml stop caddy portal ingest-web collector rollup umami
#   infra/scripts/db-export.sh /root/migracao
#
# Os dumps têm hashes de senha e sessões do portal: ficam com permissão 600 e
# precisam ser apagados depois (e nunca ir para o repositório).
set -euo pipefail

dir="${1:?uso: db-export.sh <pasta-de-saída>}"
COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod.yaml}"
here="$(cd "$(dirname "$0")" && pwd)"

umask 077
mkdir -p "$dir"
if [ -n "$(ls -A "$dir")" ]; then echo "db-export: $dir não está vazia." >&2; exit 1; fi

running=$($COMPOSE ps --status running --services | grep -v -E '^(postgres|s3)$' || true)
if [ -n "$running" ]; then
  echo "db-export: pare antes: $(echo "$running" | tr '\n' ' ')" >&2
  exit 1
fi

for db in stellytics umami; do
  echo "exportando $db..."
  # --no-password: o socket local do contêiner é confiável para o postgres.
  $COMPOSE exec -T -u postgres postgres pg_dump --no-password -Fc -d "$db" > "$dir/$db.dump"
  # Confere que o arquivo é legível antes de confiar nele.
  $COMPOSE exec -T -u postgres postgres pg_restore -l < "$dir/$db.dump" > /dev/null
done
"$here/db-fingerprint.sh" > "$dir/fingerprint.txt"
(cd "$dir" && sha256sum stellytics.dump umami.dump fingerprint.txt > sha256sums)
echo "pronto em $dir:"; ls -l "$dir"
