#!/usr/bin/env bash
# Importa os dumps de db-export.sh no Postgres de DESTINO (#54, docs/transferencia.md).
#
# O destino já passou pelo `site.yml` (Postgres com os papéis criados pelos
# scripts de init). Este script PARA a aplicação, APAGA e recria os bancos
# stellytics e umami (o app novo, ao subir, criou tabelas vazias e o restore bateria
# nelas), restaura os dumps, reaplica o 02-ingest-roles.sh e confere a
# impressão digital contra a da origem. Só depois disso suba a aplicação.
#
#   docker compose --env-file .env.production -f infra/compose/prod.yaml stop caddy portal ingest-web collector rollup umami   # antes
#   infra/scripts/db-import.sh --yes [--force-nonempty] /root/migracao
#
# Proteções, todas ANTES de apagar qualquer coisa: o sha256sums tem de listar
# stellytics.dump e umami.dump e bater; os dois dumps têm de abrir (`pg_restore -l`);
# nenhum serviço além do Postgres pode estar rodando (o script não os para);
# e o destino tem de ter 0 tenants (use --force-nonempty só se for de propósito:
# sem isso, rodar o script na VM de origem por engano apagaria a produção).
# Os dumps são restaurados em bancos temporários (stellytics_new e umami_new); só
# quando os dois restauram é que os bancos antigos são trocados por eles. Uma
# falha no restore deixa o destino como estava.

# Rode na VM de destino como root, na raiz do clone. Destrutivo:
# exige --yes.
set -euo pipefail

yes=0 force=0 dir=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --force-nonempty) force=1 ;;
    -*) echo "db-import: opção desconhecida: $arg" >&2; exit 2 ;;
    *) dir="$arg" ;;
  esac
done
if [ "$yes" != 1 ] || [ -z "$dir" ]; then
  echo "uso: db-import.sh --yes [--force-nonempty] <pasta-com-os-dumps>  (APAGA os bancos stellytics e umami do destino)" >&2
  exit 2
fi
COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod.yaml}"
here="$(cd "$(dirname "$0")" && pwd)"
pg() { $COMPOSE exec -T -u postgres postgres "$@"; }
abort() { echo "db-import: $*" >&2; exit 1; }

# 1. Integridade: o sha256sums tem de listar os dois dumps (um sha256sums só com
# o fingerprint não pode passar). Ele prova integridade, não autenticidade: a
# autenticidade vem do canal (ssh) por onde a pasta chegou.
for f in stellytics.dump umami.dump fingerprint.txt; do
  grep -q "  $f\$" "$dir/sha256sums" || abort "$dir/sha256sums não lista $f"
done
(cd "$dir" && sha256sum -c sha256sums) || abort "sha256sums não confere"

# 2. Os dumps abrem? Falhar aqui não custa nada; falhar depois do DROP custaria o banco.
for db in stellytics umami; do
  pg pg_restore -l < "$dir/$db.dump" > /dev/null || abort "$db.dump não abre (truncado ou corrompido?)"
done

# 3. Nada rodando além do Postgres (e do S3 do teste).
# O `ps` falhar (diretório ou COMPOSE errados) tem de abortar, não passar como "nada rodando".
services=$($COMPOSE ps --status running --services) || abort "não consegui listar os serviços (COMPOSE=$COMPOSE; está na raiz do clone?)"
running=$(printf '%s\n' "$services" | grep -v -E '^(postgres|s3)$' || true)
if [ -n "$running" ]; then
  abort "pare antes: $(echo "$running" | tr '\n' ' ')(docker compose --env-file .env.production -f infra/compose/prod.yaml stop ...)"
fi

# 4. O destino está vazio? (sem a tabela, ou com 0 tenants)
# Se o psql falhar, aborta: tratar falha como "0 tenants" deixaria passar a origem.
tenants=$(pg psql -X -At -d stellytics -c "select case when to_regclass('public.tenant') is null then 0 else (select count(*) from tenant) end") || abort "não consegui consultar o destino (o Postgres está de pé? o banco stellytics existe?)"
if [ "$tenants" != 0 ] && [ "$force" != 1 ]; then
  abort "o destino tem $tenants tenant(s): isto não parece um destino vazio (é a origem?). Use --force-nonempty se for de propósito."
fi

# Restaura em bancos temporários; os de verdade só mudam depois.
pg psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DROP DATABASE IF EXISTS umami_new WITH (FORCE);
DROP DATABASE IF EXISTS stellytics_new WITH (FORCE);
CREATE DATABASE umami_new OWNER umami;
CREATE DATABASE stellytics_new OWNER stellytics;
SQL
for db in stellytics umami; do
  echo "importando $db..."
  if ! pg pg_restore --no-password --exit-on-error -d "${db}_new" < "$dir/$db.dump"; then
    pg psql -X -d postgres -c "DROP DATABASE IF EXISTS umami_new WITH (FORCE)" -c "DROP DATABASE IF EXISTS stellytics_new WITH (FORCE)" >/dev/null || true
    abort "o restore de $db falhou; o destino NÃO foi alterado."
  fi
done

# Troca. Mesmos comandos do 01-databases.sh quanto a dono e REVOKE. A partir
# daqui os bancos antigos já não existem.
pg psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DROP DATABASE IF EXISTS umami WITH (FORCE);
DROP DATABASE IF EXISTS stellytics WITH (FORCE);
ALTER DATABASE umami_new RENAME TO umami;
ALTER DATABASE stellytics_new RENAME TO stellytics;
REVOKE ALL ON DATABASE umami FROM PUBLIC;
REVOKE ALL ON DATABASE stellytics FROM PUBLIC;
SQL

# CONNECT dos usuários do gateway e do coletor é permissão do banco, que o dump
# não leva. O script é idempotente.
$COMPOSE exec -T postgres sh < "$here/../compose/postgres/init/02-ingest-roles.sh"

echo "conferindo contra a origem..."
"$here/db-fingerprint.sh" > "$dir/fingerprint-destino.txt"
# Papéis e ACL dos bancos podem diferir só se alguém mexeu; o resto tem de ser idêntico.
if diff -u "$dir/fingerprint.txt" "$dir/fingerprint-destino.txt"; then
  echo "OK: destino idêntico à origem. Pode subir a aplicação."
else
  echo "FALHOU: o destino difere da origem (diff acima). NÃO suba a aplicação." >&2
  exit 1
fi
