#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/prod.yaml"
ENV_FILE="$ROOT_DIR/.env.production"
UNIT_DIR=/etc/systemd/system

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$*"
}

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy.sh

Validates .env.production, builds the application images and starts the
production stack on this VPS: the public demo portal, web gateway, OTLP API,
Umami, Postgres with continuous backup (WAL-G), rollup and Caddy. Data in
STELLYTICS_DATA_DIR (/srv/stellytics). Images set in PORTAL_IMAGE,
INGEST_WEB_IMAGE, COLLECTOR_IMAGE or ROLLUP_IMAGE are pulled instead of built.

The portal is public and read-only: /demo and /operator show sample data,
or the project named in DEMO_TENANT_SLUG (which then needs UMAMI_API_KEY).
Run it again after changing .env.production or updating the checkout.
USAGE
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

preflight() {
  [[ "$EUID" -eq 0 ]] || fail "run with sudo: sudo ./deploy.sh"
  command -v docker >/dev/null 2>&1 || fail "Docker not found; run sudo ./init.sh first"
  command -v python3 >/dev/null 2>&1 || fail "Python 3 not found; run sudo ./init.sh first"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose not found; run sudo ./init.sh first"
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not running"
  [[ -f "$ENV_FILE" ]] || fail "missing file: $ENV_FILE (run sudo ./init.sh first)"
  [[ -f "$COMPOSE_FILE" ]] || fail "missing production Compose file: $COMPOSE_FILE"

  step "Validating .env.production and the Compose configuration"
  python3 "$ROOT_DIR/infra/scripts/production-env.py" validate "$ENV_FILE"
  "${compose[@]}" config --quiet
}

# A service with an image override (usually a signed release image, by
# digest) is pulled; building it would fail on the digest or overwrite the
# release tag with a local build.
prepare_images() {
  local build=(postgres) pull=() pair
  for pair in portal=PORTAL_IMAGE ingest-web=INGEST_WEB_IMAGE collector=COLLECTOR_IMAGE rollup=ROLLUP_IMAGE; do
    if [[ -n "$(env_value "${pair#*=}")" ]]; then
      pull+=("${pair%%=*}")
    else
      build+=("${pair%%=*}")
    fi
  done

  step "Building images: ${build[*]}"
  "${compose[@]}" build "${build[@]}"
  if [[ ${#pull[@]} -gt 0 ]]; then
    step "Pulling images: ${pull[*]}"
    "${compose[@]}" pull "${pull[@]}"
  fi
}

start_stack() {
  step "Starting the production stack"
  "${compose[@]}" up -d --no-build --wait --remove-orphans

  # Compose does not recreate Caddy when only the mounted Caddyfile changes.
  # Reload it: a no-op when unchanged; an invalid file fails here and the
  # running config stays.
  "${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

install_timers() {
  local docker_bin python_bin data_dir
  docker_bin="$(command -v docker)"
  python_bin="$(command -v python3)"
  data_dir="$(env_value STELLYTICS_DATA_DIR)"
  data_dir="${data_dir:-/srv/stellytics}"

  step "Installing the backup and stack check timers"

  # Daily Postgres base backup (WAL goes continuously through archive_command).
  cat > "$UNIT_DIR/stellytics-backup.service" <<UNIT
[Unit]
Description=stellytics: Postgres base backup (WAL-G)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$docker_bin compose --env-file $ENV_FILE -f $COMPOSE_FILE exec -T -u postgres postgres stellytics-backup
UNIT
  cat > "$UNIT_DIR/stellytics-backup.timer" <<'UNIT'
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
  cat > "$UNIT_DIR/stellytics-check.service" <<UNIT
[Unit]
Description=stellytics: stack check for the external monitoring
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
Environment="COMPOSE=$docker_bin compose --env-file $ENV_FILE -f $COMPOSE_FILE"
ExecStart=$python_bin $ROOT_DIR/infra/scripts/stack-check.py $data_dir
UNIT
  cat > "$UNIT_DIR/stellytics-check.timer" <<'UNIT'
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
}

# With no base backup in storage (first deploy), do not wait for 03:00: the
# check reports it missing and a restore would have no starting point.
# WAL-G retries an unreachable storage for about half an hour: give up
# after 2 minutes instead of hanging the deploy.
ensure_first_backup() {
  local backups
  step "Checking the base backups"
  if ! backups="$(timeout 120 "${compose[@]}" exec -T -u postgres postgres wal-g backup-list --json 2>/dev/null)"; then
    fail "the stack is up, but listing the backups failed; check WALG_S3_* in $ENV_FILE and run sudo ./deploy.sh again"
  fi
  if grep -q '"backup_name"' <<<"$backups"; then
    printf 'Base backup found in storage.\n'
  else
    printf 'No base backup in storage: starting the first one in the background.\n'
    systemctl start --no-block stellytics-backup.service
  fi
}

summary() {
  local portal_host demo_slug
  portal_host="$(env_value PORTAL_HOST)"
  demo_slug="$(env_value DEMO_TENANT_SLUG)"

  step "Service status"
  "${compose[@]}" ps

  printf '\nPublic demo:\n'
  printf '  https://%s/demo\n' "$portal_host"
  printf '  https://%s/operator\n' "$portal_host"
  if [[ -n "$demo_slug" ]]; then
    printf '  Showing the project "%s" (an unknown or inactive slug answers 404).\n' "$demo_slug"
  else
    printf '  Showing sample data (DEMO_TENANT_SLUG is empty).\n'
  fi
  printf 'Checks: docs/deploy.md, section "3. Check production".\n'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || fail "unknown argument; use --help"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

preflight
prepare_images
start_stack
install_timers
ensure_first_backup
summary
