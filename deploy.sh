#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/prod.yaml"
ENV_FILE="$ROOT_DIR/.env.production"

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

# Last value of $1 in .env.production, without surrounding quotes.
env_value() {
  local value
  value="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: sudo ./deploy.sh

Validates .env.production, builds the application images and starts the
production stack on this VPS: portal, web gateway, OTLP API, Umami, Postgres
with continuous backup (WAL-G), rollup and Caddy. Data in STELLYTICS_DATA_DIR
(/srv/stellytics). Images set in PORTAL_IMAGE, INGEST_WEB_IMAGE,
COLLECTOR_IMAGE or ROLLUP_IMAGE are pulled instead of built.
USAGE
  exit 0
fi

[[ $# -eq 0 ]] || fail "unknown argument; use --help"
[[ "$EUID" -eq 0 ]] || fail "run with sudo: sudo ./deploy.sh"
command -v docker >/dev/null 2>&1 || fail "Docker not found; run sudo ./init.sh first"
command -v python3 >/dev/null 2>&1 || fail "Python 3 not found; run sudo ./init.sh first"
docker compose version >/dev/null 2>&1 || fail "Docker Compose not found; run sudo ./init.sh first"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not running"
[[ -f "$ENV_FILE" ]] || fail "missing file: $ENV_FILE (run sudo ./init.sh first)"
[[ -f "$COMPOSE_FILE" ]] || fail "missing production Compose file: $COMPOSE_FILE"

python3 "$ROOT_DIR/infra/scripts/production-env.py" validate "$ENV_FILE"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
printf 'Validating the Compose configuration...\n'
"${compose[@]}" config --quiet

# A service with an image override (usually a signed release image, by
# digest) is pulled; building it would fail on the digest or overwrite the
# release tag with a local build.
build=(postgres)
pull=()
for pair in portal=PORTAL_IMAGE ingest-web=INGEST_WEB_IMAGE collector=COLLECTOR_IMAGE rollup=ROLLUP_IMAGE; do
  if [[ -n "$(env_value "${pair#*=}")" ]]; then
    pull+=("${pair%%=*}")
  else
    build+=("${pair%%=*}")
  fi
done

printf 'Building images: %s\n' "${build[*]}"
"${compose[@]}" build "${build[@]}"
if [[ ${#pull[@]} -gt 0 ]]; then
  printf 'Pulling images: %s\n' "${pull[*]}"
  "${compose[@]}" pull "${pull[@]}"
fi

printf 'Starting the production stack...\n'
"${compose[@]}" up -d --no-build --wait --remove-orphans

# Compose does not recreate Caddy when only the mounted Caddyfile changes.
# Reload it: a no-op when unchanged; an invalid file fails here and the
# running config stays.
"${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Daily Postgres base backup (WAL goes continuously through archive_command).
cat > /etc/systemd/system/stellytics-backup.service <<UNIT
[Unit]
Description=stellytics: Postgres base backup (WAL-G)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$(command -v docker) compose --env-file $ENV_FILE -f $COMPOSE_FILE exec -T -u postgres postgres stellytics-backup
UNIT
cat > /etc/systemd/system/stellytics-backup.timer <<'UNIT'
[Unit]
Description=stellytics: daily Postgres base backup

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
UNIT

# Stack check every minute (infra/scripts/stack-check.py): containers, WAL
# archiving, base backup age and disk. The result becomes Caddy's
# /healthz/stack, which the external monitoring probes.
data_dir="$(env_value STELLYTICS_DATA_DIR)"
data_dir="${data_dir:-/srv/stellytics}"
cat > /etc/systemd/system/stellytics-check.service <<UNIT
[Unit]
Description=stellytics: stack check for the external monitoring
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
Environment="COMPOSE=$(command -v docker) compose --env-file $ENV_FILE -f $COMPOSE_FILE"
ExecStart=$(command -v python3) $ROOT_DIR/infra/scripts/stack-check.py $data_dir
UNIT
cat > /etc/systemd/system/stellytics-check.timer <<'UNIT'
[Unit]
Description=stellytics: stack check every minute

[Timer]
OnCalendar=*:*:00
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now stellytics-backup.timer stellytics-check.timer

# With no base backup in storage (first deploy), do not wait for 03:00: the
# check reports it missing and a restore would have no starting point.
# WAL-G retries an unreachable storage for about half an hour: give up
# after 2 minutes instead of hanging the deploy.
printf '\nService status:\n'
"${compose[@]}" ps
if ! backups="$(timeout 120 "${compose[@]}" exec -T -u postgres postgres wal-g backup-list --json 2>/dev/null)"; then
  fail "the stack is up, but listing the backups failed; check WALG_S3_* in $ENV_FILE and run sudo ./deploy.sh again"
fi
if ! grep -q '"backup_name"' <<<"$backups"; then
  printf 'No base backup in storage: starting the first one in the background.\n'
  systemctl start --no-block stellytics-backup.service
fi
