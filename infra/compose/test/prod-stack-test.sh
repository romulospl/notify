#!/usr/bin/env bash
# Teste da pilha de produção (#14), localmente e no job `prod-stack` do CI.
#
# Sobe compose/prod.yaml com um S3 local (test/prod-test.yaml) e confere:
# 1. Caddy publica o portal, só as rotas do gateway e só o OTLP; Umami não vaza;
# 2. Caddy é o único serviço público; Postgres fica no loopback;
# 1b. o /healthz do gateway dá 503 com o Umami fora do ar;
# 2b. uma métrica OTLP com chave de ingestão cai em
#    api_metric_1m no tenant da chave, e o rollup roda;
# 3. o backup base e o WAL vão para o S3, cifrados, e a checagem da pilha
#    (stack-check.py, /healthz/stack) só fica verde com o backup feito;
# 4. a restauração, seguindo docs/deploy.md, traz o banco de volta, inclusive
#    o que foi gravado DEPOIS do backup base (recuperação pelo WAL arquivado).
#
# Uso, da raiz do repositório, com as imagens já construídas
# (docker compose build portal ingest-web collector rollup):
#   infra/compose/test/prod-stack-test.sh
# PORTAL_IMAGE, INGEST_WEB_IMAGE, COLLECTOR_IMAGE e ROLLUP_IMAGE trocam as
# imagens (padrão: as do ambiente local).
set -euo pipefail

cd "$(dirname "$0")/.."
project=stellytics-prodtest
work=$(mktemp -d "${TMPDIR:-/tmp}/stellytics-prodtest.XXXXXX")
env_file="$work/.env"
rand() { openssl rand -hex "${1:-24}"; }

cat > "$env_file" <<EOF
POSTGRES_PASSWORD=$(rand)
UMAMI_DB_PASSWORD=$(rand)
STELLYTICS_DB_PASSWORD=$(rand)
STELLYTICS_INGEST_DB_PASSWORD=$(rand)
STELLYTICS_COLLECTOR_DB_PASSWORD=$(rand)
UMAMI_APP_SECRET=$(rand)
PORTAL_AUTH_SECRET=$(rand)
INGEST_PROOF_SECRET=$(rand)
WALG_S3_PREFIX=s3://stellytics-backup/test
WALG_S3_ENDPOINT=http://s3:8333
WALG_S3_REGION=us-east-1
WALG_S3_ACCESS_KEY=$(rand 10)
WALG_S3_SECRET_KEY=$(rand)
WALG_LIBSODIUM_KEY=$(rand 32)
PORTAL_IMAGE=${PORTAL_IMAGE:-stellytics-portal:dev}
INGEST_WEB_IMAGE=${INGEST_WEB_IMAGE:-stellytics-ingest-web:dev}
COLLECTOR_IMAGE=${COLLECTOR_IMAGE:-stellytics-collector:dev}
ROLLUP_IMAGE=${ROLLUP_IMAGE:-stellytics-rollup:dev}
PORTAL_HOST=portal.localhost
PORTAL_ALIAS_HOST=alias.localhost
INGEST_HOST=ingest.localhost
API_HOST=api.localhost
ACME_EMAIL=ops@example.org
SMTP_URL=smtp://127.0.0.1:25
MAIL_FROM=stellytics <no-reply@example.org>
STELLYTICS_DATA_DIR=$work/data
POSTGRES_ADMIN_PORT=15432
EOF

compose() { docker compose -p "$project" --env-file "$env_file" -f prod.yaml -f test/prod-test.yaml "$@"; }
psql_stellytics() { compose exec -T -u postgres postgres psql -d stellytics -Atc "$1"; }

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

# A pasta status é do stack-check; criada antes, para não ficar com o root do Docker.
mkdir -p "$work/data/status"
compose up -d s3 --wait
compose exec -T s3 sh -c 'echo "s3.bucket.create -name stellytics-backup" | weed shell -master=localhost:9333' >/dev/null
compose up -d --build --wait

# 1. Rotas do Caddy (certificado interno para *.localhost).
get() { curl -sk -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }
[ "$(get portal.localhost /sign-in)" = 200 ] || fail "portal em /sign-in"
# O otimizador não é usado pelo portal; nenhuma biblioteca sharp/libvips ou
# pacote de dados caniuse-lite deve ser distribuído no standalone. O 404 tem
# corpo vazio (guarda do proxy); o 404 nativo do Next viria com HTML, então a
# resposta confere também que a guarda não foi removida. A barra final recebe
# o 308 de normalização do próprio Next e, seguido o redirecionamento, o 404
# da guarda; o caminho percent-encodado prova que a guarda decodifica (sem
# isso viraria redirecionamento para /sign-in).
img404=$(curl -sk --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}' "https://portal.localhost/_next/image?url=%2Ffavicon.ico&w=64&q=75")
[ "$img404" = "404 0" ] || fail "otimizador de imagens deveria estar desligado (retornou \"$img404\", esperado 404 com corpo vazio)"
img404=$(curl -sk --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}' "https://portal.localhost/_next/%69mage?url=%2Ffavicon.ico&w=64&q=75")
[ "$img404" = "404 0" ] || fail "otimizador com caminho percent-encodado deveria dar 404 da guarda do proxy (retornou \"$img404\")"
img404=$(curl -skL --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}' "https://portal.localhost/_next/image/?url=%2Ffavicon.ico&w=64&q=75")
[ "$img404" = "404 0" ] || fail "otimizador com barra final deveria dar 404 depois do redirecionamento do Next (retornou \"$img404\")"
license_files=$(compose exec -T portal sh -c 'find /app -path "*/node_modules/*" \( -name "@img+sharp-*" -o -name "sharp-*" -o -name "sharp@*" -o -name sharp -o -name "caniuse-lite" -o -name "caniuse-lite@*" \) -print; find /app -name "*.node" -print') || fail "não foi possível inspecionar a imagem do portal"
[ -z "$license_files" ] || fail "imagem do portal contém dependências removidas: $license_files"

[ "$(get ingest.localhost /healthz)" = 200 ] || fail "gateway em /healthz"
for path in /api/send /api/heartbeat /api/websites /api/record /; do
  [ "$(get ingest.localhost "$path")" = 404 ] || fail "host da ingestão deveria dar 404 em $path"
done
# No host do portal, /api/heartbeat é do Next (404), não do Umami.
[ "$(curl -sk --resolve portal.localhost:443:127.0.0.1 https://portal.localhost/api/heartbeat)" != "ok" ] || fail "o host do portal chega ao Umami"
[ "$(curl -sk --resolve alias.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://alias.localhost/sign-in)" = 301 ] || fail "o alias do portal não redireciona"

# Host da API (ADR 0012): só o OTLP, e só com chave de ingestão.
post() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
  --resolve api.localhost:443:127.0.0.1 "https://api.localhost$1"; }
for path in /v1/traces /v1/metrics /v1/logs; do
  [ "$(post "$path")" = 401 ] || fail "OTLP sem chave em $path deveria dar 401"
done
for path in / /healthz /e /api/send /v1/metrics; do
  [ "$(get api.localhost "$path")" = 404 ] || fail "host da API deveria dar 404 no GET $path"
done
[ "$(post /api/send)" = 404 ] || fail "host da API chega a outra rota por POST"
# gRPC local: sem chave, o coletor responde Unauthenticated (grpc-status 16).
# O corpo é uma mensagem gRPC vazia (5 bytes de cabeçalho): o servidor lê a
# mensagem antes de conferir a chave.
grpc_status=$(printf '\0\0\0\0\0' | curl -sk --http2 -o /dev/null -D - -X POST --data-binary @- \
  -H 'Content-Type: application/grpc' -H 'TE: trailers' \
  --resolve api.localhost:443:127.0.0.1 \
  https://api.localhost/opentelemetry.proto.collector.metrics.v1.MetricsService/Export |
  tr -d '\r' | awk 'tolower($1) == "grpc-status:" { print $2 }')
[ "$grpc_status" = 16 ] || fail "gRPC sem chave deveria dar grpc-status 16 e veio '$grpc_status'"
ok "Caddy publica o portal, só as rotas do gateway e só o OTLP (HTTP e gRPC) do coletor"

# Os logs não devem guardar IP, cabeçalhos ou URL, mesmo em erro de upstream.
marker="marcador-$(rand 6)"
compose stop ingest-web >/dev/null
code=$(curl -sk -o /dev/null -w '%{http_code}' -H "X-Stellytics-Test: $marker" \
  --resolve ingest.localhost:443:127.0.0.1 "https://ingest.localhost/healthz?m=$marker")
[ "$code" = 502 ] || fail "com o gateway parado, esperava 502 e veio $code"
caddy_logs=$(compose logs --no-color caddy)
grep -q '"status":502' <<<"$caddy_logs" || fail "o Caddy não registrou o erro 502 (teste sem efeito)"
if grep -qE "$marker|remote_ip|client_ip" <<<"$caddy_logs"; then fail "o log do Caddy guarda IP, cabeçalho ou URL do pedido"; fi
compose up -d --wait ingest-web >/dev/null
ok "logs do Caddy sem IP, cabeçalhos nem URL"

# 1b. O /healthz do gateway mede a ingestão: com o Umami fora, 503.
compose stop umami >/dev/null
for _ in $(seq 1 20); do
  code=$(get ingest.localhost /healthz)
  [ "$code" = 503 ] && break
  sleep 1
done
[ "$code" = 503 ] || fail "com o Umami parado, /healthz deveria dar 503 e deu $code"
compose up -d --wait umami >/dev/null
for _ in $(seq 1 20); do
  code=$(get ingest.localhost /healthz)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || fail "com o Umami de volta, /healthz deveria dar 200 e deu $code"
ok "/healthz do gateway dá 503 sem o Umami e volta a 200"

# Checagem da pilha (stellytics-check em produção), com o Compose deste teste.
stack_check() {
  COMPOSE="docker compose -p $project --env-file $env_file -f prod.yaml -f test/prod-test.yaml" \
    STACK_CHECK_DISK_MAX_PERCENT=100 python3 ../scripts/stack-check.py "$work/data"
}
# Sem backup base ainda: a checagem acusa e o Caddy responde 503.
if out=$(stack_check); then fail "a checagem da pilha passou sem backup base: $out"; fi
grep -q "no base backup" <<<"$out" || fail "a checagem não acusou a falta de backup base: $out"
[ "$(get ingest.localhost /healthz/stack)" = 503 ] || fail "/healthz/stack sem a checagem verde deveria dar 503"
ok "checagem da pilha falha sem backup base e /healthz/stack dá 503"

# 2. Só Caddy publica portas públicas; Postgres fica no loopback.
bindings() { docker inspect -f '{{json .HostConfig.PortBindings}}' "$(compose ps -q "$1")"; }
for svc in umami portal ingest-web collector rollup s3; do
  b=$(bindings "$svc")
  [ "$b" = "{}" ] || [ "$b" = "null" ] || fail "$svc com porta publicada: $b"
done
caddy_bindings=$(bindings caddy)
grep -q '80/tcp' <<<"$caddy_bindings" && grep -q '443/tcp' <<<"$caddy_bindings" || fail "Caddy não publica 80/443: $caddy_bindings"
pg_port=$(compose port postgres 5432)
case "$pg_port" in 127.0.0.1:*) ;; *) fail "Postgres publicado fora do loopback: $pg_port" ;; esac
ok "Caddy é o único serviço público; Umami e rollup sem porta; Postgres só no loopback"

# 2b. Ingestão OTLP de ponta a ponta pelo Caddy: a chave define o tenant.
suffix=$(rand 5)
prefix=$(LC_ALL=C tr -dc 'a-z2-7' </dev/urandom | head -c 8 || true)
key="ntf_${prefix}_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 43 || true)"
psql_stellytics "insert into \"user\" (id, name, email, email_verified)
  values ('prodtest-$suffix', 'prodtest', 'prodtest-$suffix@example.invalid', true)" >/dev/null
tenant=$(psql_stellytics "insert into tenant (name, slug, status) values ('prodtest-$suffix', 'prodtest-$suffix', 'active') returning id" | head -1)
service=$(psql_stellytics "insert into api_service (tenant_id, name) values ('$tenant', 'prodtest') returning id" | head -1)
psql_stellytics "insert into ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by)
  values ('$service', '$tenant', '$prefix', sha256(convert_to('$key', 'UTF8')), 'prodtest-$suffix')" >/dev/null
now=$(date +%s)000000000
code=$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  --resolve api.localhost:443:127.0.0.1 https://api.localhost/v1/traces \
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"GET","kind":2,"startTimeUnixNano":"'"$now"'","endTimeUnixNano":"'"$now"'","attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/prodtest/{id}"}},{"key":"http.response.status_code","value":{"intValue":"200"}}]}]}]}]}')
[ "$code" = 200 ] || fail "OTLP com chave válida respondeu $code"
for _ in $(seq 1 30); do
  n=$(psql_stellytics "select count(*) from api_metric_1m where route = '/prodtest/{id}' and tenant_id = '$tenant' and api_service_id = '$service'")
  [ "$n" -ge 1 ] && break
  sleep 2
done
[ "$n" -ge 1 ] || fail "a métrica enviada pelo coletor não chegou a api_metric_1m"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ntf_aaaaaaaa_invalida' -H 'Content-Type: application/json' -d '{}' \
  --resolve api.localhost:443:127.0.0.1 https://api.localhost/v1/traces)" = 401 ] || fail "chave inválida deveria dar 401"
if compose logs --no-color collector | grep -q "$key"; then fail "a chave de ingestão apareceu num log"; fi
# O rollup criou as partições do mês (api_metric_maintain) ao subir.
[ "$(psql_stellytics "select count(*) from pg_class where relname = 'api_metric_1h_p$(date -u +%Y%m)'")" = 1 ] ||
  fail "o rollup não criou a partição do mês em api_metric_1h"
ok "OTLP grava em api_metric_1m no tenant da chave; rollup no ar"

# 3. Backup base e WAL no S3.
psql_stellytics "create table restore_check (note text primary key)"
psql_stellytics "insert into restore_check values ('before-backup')"
compose exec -T -u postgres postgres stellytics-backup >/dev/null
psql_stellytics "insert into restore_check values ('after-backup')"
wal=$(psql_stellytics "select pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 60); do
  archived=$(psql_stellytics "select coalesce(last_archived_wal, '') from pg_stat_archiver")
  [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && break
  sleep 1
done
[[ "$archived" > "$wal" || "$archived" == "$wal" ]] || fail "WAL $wal não foi arquivado (último: $archived)"
ok "backup base e WAL $wal no S3"

out=$(stack_check) || fail "a checagem da pilha falhou com tudo no ar: $out"
[ "$(get ingest.localhost /healthz/stack)" = 200 ] || fail "/healthz/stack com a checagem verde deveria dar 200"
compose stop rollup >/dev/null
if out=$(stack_check); then fail "a checagem da pilha passou com o rollup parado: $out"; fi
grep -q "rollup: exited" <<<"$out" || fail "a checagem não acusou o rollup parado: $out"
[ "$(get ingest.localhost /healthz/stack)" = 503 ] || fail "/healthz/stack com o rollup parado deveria dar 503"
compose up -d --wait rollup >/dev/null
ok "checagem da pilha verde com backup e WAL em dia; acusa um serviço parado"

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
  -c 'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore"' >/dev/null
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
  compose stop caddy portal ingest-web collector rollup umami postgres >/dev/null
  docker run --rm -v "$work/data:/d" alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f \
    sh -c "mv /d/postgres /d/postgres.antes-$1 && mkdir /d/postgres"
  compose run --rm --no-deps -e BACKUP="$2" -e TARGET="${3:-}" --entrypoint sh postgres -c \
    'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore \"$BACKUP\" \"$TARGET\""' >/dev/null
  compose up -d --wait >/dev/null
  [ "$(psql_stellytics "select pg_is_in_recovery()")" = f ] || fail "o banco restaurado ficou em recuperação"
}
notes() { psql_stellytics "select string_agg(note, ',' order by note) from restore_check"; }
archive_now() {
  local wal archived
  wal=$(psql_stellytics "select pg_walfile_name(pg_switch_wal())")
  for _ in $(seq 1 60); do
    archived=$(psql_stellytics "select coalesce(last_archived_wal, '') from pg_stat_archiver")
    [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && return 0
    sleep 1
  done
  fail "WAL $wal não foi arquivado"
}

# 4a. Até um horário: depois das duas linhas, antes da terceira.
target=$(psql_stellytics "select now()")
sleep 1
psql_stellytics "insert into restore_check values ('after-target')"
archive_now
restore_db 1 LATEST "$target"
[ "$(notes)" = "after-backup,before-backup" ] || fail "restauração até $target trouxe '$(notes)'"
ok "restauração até um horário: backup base, WAL até o alvo e nada depois dele"

# 4b. Backup novo depois da restauração e restauração completa: o alvo da
# restauração anterior vem dentro do backup e não pode valer de novo.
compose exec -T -u postgres postgres stellytics-backup >/dev/null
psql_stellytics "insert into restore_check values ('after-second-backup')"
archive_now
restore_db 2 LATEST
[ "$(notes)" = "after-backup,after-second-backup,before-backup" ] || fail "segunda restauração trouxe '$(notes)'"
ok "restauração completa depois de outra restauração recupera todo o WAL"

echo "pilha de produção: tudo certo"
