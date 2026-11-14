#!/usr/bin/env bash
# Teste da pilha de produção (#14), localmente e no job `prod-stack` do CI.
#
# Sobe compose/prod.yaml com um S3 local (test/prod-test.yaml) e confere:
# 1. o Caddy publica o portal e só as rotas do gateway; nada leva ao Umami;
# 2. Umami e Postgres não têm porta pública;
# 3. o backup base e o WAL vão para o S3, cifrados;
# 4. a restauração, seguindo docs/deploy.md, traz o banco de volta, inclusive
#    o que foi gravado DEPOIS do backup base (recuperação pelo WAL arquivado).
#
# Uso, da raiz do repositório, com as imagens do portal e do gateway já
# construídas (docker compose build portal ingest-web):
#   infra/compose/test/prod-stack-test.sh
# PORTAL_IMAGE e INGEST_WEB_IMAGE trocam as imagens (padrão: as do ambiente local).
set -euo pipefail

cd "$(dirname "$0")/.."
project=notify-prodtest
work=$(mktemp -d "${TMPDIR:-/tmp}/notify-prodtest.XXXXXX")
env_file="$work/.env"
rand() { openssl rand -hex "${1:-24}"; }

cat > "$env_file" <<EOF
POSTGRES_PASSWORD=$(rand)
UMAMI_DB_PASSWORD=$(rand)
NOTIFY_DB_PASSWORD=$(rand)
NOTIFY_INGEST_DB_PASSWORD=$(rand)
NOTIFY_COLLECTOR_DB_PASSWORD=$(rand)
UMAMI_APP_SECRET=$(rand)
PORTAL_AUTH_SECRET=$(rand)
INGEST_PROOF_SECRET=$(rand)
WALG_S3_PREFIX=s3://notify-backup/test
WALG_S3_ENDPOINT=http://s3:8333
WALG_S3_REGION=us-east-1
WALG_S3_ACCESS_KEY=$(rand 10)
WALG_S3_SECRET_KEY=$(rand)
WALG_LIBSODIUM_KEY=$(rand 32)
PORTAL_IMAGE=${PORTAL_IMAGE:-notify-portal:dev}
INGEST_WEB_IMAGE=${INGEST_WEB_IMAGE:-notify-ingest-web:dev}
PORTAL_HOST=portal.localhost
INGEST_HOST=ingest.localhost
ACME_EMAIL=ops@example.org
SMTP_URL=smtp://127.0.0.1:25
MAIL_FROM=notify <no-reply@example.org>
NOTIFY_DATA_DIR=$work/data
POSTGRES_ADMIN_PORT=15432
EOF

compose() { docker compose -p "$project" --env-file "$env_file" -f prod.yaml -f test/prod-test.yaml "$@"; }
psql_notify() { compose exec -T -u postgres postgres psql -d notify -Atc "$1"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --tail 80 >&2 || true; fi
  docker rm -f "$project-nokey" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  # Os dados são do usuário do Postgres no contêiner; apaga por um contêiner.
  docker run --rm -v "$work:/w" alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f rm -rf /w/data >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FALHOU: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

mkdir -p "$work/data"
compose up -d s3 --wait
compose exec -T s3 sh -c 'echo "s3.bucket.create -name notify-backup" | weed shell -master=localhost:9333' >/dev/null
compose up -d --build --wait

# 1. Rotas do Caddy (certificado interno para *.localhost).
get() { curl -sk -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }
[ "$(get portal.localhost /sign-in)" = 200 ] || fail "portal em /sign-in"
[ "$(get ingest.localhost /healthz)" = 200 ] || fail "gateway em /healthz"
for path in /api/send /api/heartbeat /api/websites /api/record /; do
  [ "$(get ingest.localhost "$path")" = 404 ] || fail "host da ingestão deveria dar 404 em $path"
done
# No host do portal, /api/heartbeat é do Next (404), não do Umami.
[ "$(curl -sk --resolve portal.localhost:443:127.0.0.1 https://portal.localhost/api/heartbeat)" != "ok" ] \
  || fail "o host do portal chega ao Umami"
ok "Caddy publica o portal e só as rotas do gateway"

# Logs do Caddy sem IP, cabeçalhos nem URL, também nos de erro: com o gateway
# parado, o pedido dá 502 e o Caddy registra o erro.
marker="marcador-$(rand 6)"
compose stop ingest-web >/dev/null
code=$(curl -sk -o /dev/null -w '%{http_code}' -H "X-Notify-Test: $marker" \
  --resolve ingest.localhost:443:127.0.0.1 "https://ingest.localhost/healthz?m=$marker")
[ "$code" = 502 ] || fail "com o gateway parado, esperava 502 e veio $code"
caddy_logs=$(compose logs --no-color caddy)
grep -q '"status":502' <<<"$caddy_logs" || fail "o Caddy não registrou o erro 502 (teste sem efeito)"
if grep -qE "$marker|remote_ip|client_ip" <<<"$caddy_logs"; then
  fail "o log do Caddy guarda IP, cabeçalho ou URL do pedido"
fi
compose up -d --wait ingest-web >/dev/null
ok "logs do Caddy sem IP, cabeçalhos nem URL"

# 2. Sem porta pública além do Caddy.
bindings() { docker inspect -f '{{json .HostConfig.PortBindings}}' "$(compose ps -q "$1")"; }
for svc in umami portal ingest-web s3; do
  b=$(bindings "$svc")
  [ "$b" = "{}" ] || [ "$b" = "null" ] || fail "$svc com porta publicada: $b"
done
pg_port=$(compose port postgres 5432)
case "$pg_port" in 127.0.0.1:*) ;; *) fail "Postgres publicado fora do loopback: $pg_port" ;; esac
ok "Umami sem porta; Postgres só no loopback"

# 3. Backup base e WAL no S3.
psql_notify "create table restore_check (note text primary key)"
psql_notify "insert into restore_check values ('before-backup')"
compose exec -T -u postgres postgres notify-backup >/dev/null
psql_notify "insert into restore_check values ('after-backup')"
wal=$(psql_notify "select pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 60); do
  archived=$(psql_notify "select coalesce(last_archived_wal, '') from pg_stat_archiver")
  [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && break
  sleep 1
done
[[ "$archived" > "$wal" || "$archived" == "$wal" ]] || fail "WAL $wal não foi arquivado (último: $archived)"
ok "backup base e WAL $wal no S3"

# Cifrado no cliente: sem a chave, o backup não serve para nada. O WAL-G
# tenta baixar de novo para sempre (com WALG_DOWNLOAD_FILE_RETRIES baixo, o
# contador fica negativo e ele não para; visto na v3.0.9), então a tentativa
# roda em segundo plano e o teste só espera o erro de extração.
image=$(compose images -q postgres | head -1)
network="${project}_internal"
get_env() { grep "^$1=" "$env_file" | cut -d= -f2-; }
cat > "$work/nokey.env" <<EOF2
WALG_S3_PREFIX=$(get_env WALG_S3_PREFIX)
WALG_COMPRESSION_METHOD=brotli
AWS_S3_FORCE_PATH_STYLE=true
AWS_ENDPOINT=http://s3:8333
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=$(get_env WALG_S3_ACCESS_KEY)
AWS_SECRET_ACCESS_KEY=$(get_env WALG_S3_SECRET_KEY)
POSTGRES_PASSWORD=unused
PGDATA=/var/lib/postgresql/data
EOF2
mkdir -p "$work/data/nokey"
docker run -d --name "$project-nokey" --network "$network" -v "$work/data/nokey:/var/lib/postgresql/data" \
  --env-file "$work/nokey.env" --entrypoint sh "$image" \
  -c 'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "notify-restore"' >/dev/null
for _ in $(seq 1 60); do
  docker logs "$project-nokey" 2>&1 | grep -q "Extraction error" && break
  sleep 1
done
docker logs "$project-nokey" 2>&1 | grep -q "Extraction error" || fail "sem a chave, o WAL-G não deu erro de extração"
docker rm -f "$project-nokey" >/dev/null
[ ! -e "$work/data/nokey/PG_VERSION" ] || fail "o backup foi restaurado sem a chave WALG_LIBSODIUM_KEY"
ok "backup cifrado: sem a chave, a restauração falha"

# 4. Restauração, com os mesmos comandos de docs/deploy.md ("Restaurar o
# banco"): guarda os dados atuais, restaura numa pasta vazia e sobe de novo.
restore_db() {
  compose stop caddy portal ingest-web umami postgres >/dev/null
  docker run --rm -v "$work/data:/d" alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f \
    sh -c "mv /d/postgres /d/postgres.antes-$1 && mkdir /d/postgres"
  compose run --rm --no-deps -e BACKUP="$2" -e TARGET="${3:-}" --entrypoint sh postgres -c \
    'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "notify-restore \"$BACKUP\" \"$TARGET\""' >/dev/null
  compose up -d --wait >/dev/null
  [ "$(psql_notify "select pg_is_in_recovery()")" = f ] || fail "o banco restaurado ficou em recuperação"
}
notes() { psql_notify "select string_agg(note, ',' order by note) from restore_check"; }
archive_now() {
  local wal archived
  wal=$(psql_notify "select pg_walfile_name(pg_switch_wal())")
  for _ in $(seq 1 60); do
    archived=$(psql_notify "select coalesce(last_archived_wal, '') from pg_stat_archiver")
    [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && return 0
    sleep 1
  done
  fail "WAL $wal não foi arquivado"
}

# 4a. Até um horário: depois das duas linhas, antes da terceira.
target=$(psql_notify "select now()")
sleep 1
psql_notify "insert into restore_check values ('after-target')"
archive_now
restore_db 1 LATEST "$target"
[ "$(notes)" = "after-backup,before-backup" ] || fail "restauração até $target trouxe '$(notes)'"
ok "restauração até um horário: backup base, WAL até o alvo e nada depois dele"

# 4b. Backup novo depois da restauração e restauração completa: o alvo da
# restauração anterior vem dentro do backup e não pode valer de novo.
compose exec -T -u postgres postgres notify-backup >/dev/null
psql_notify "insert into restore_check values ('after-second-backup')"
archive_now
restore_db 2 LATEST
[ "$(notes)" = "after-backup,after-second-backup,before-backup" ] || fail "segunda restauração trouxe '$(notes)'"
ok "restauração completa depois de outra restauração recupera todo o WAL"

echo "pilha de produção: tudo certo"
