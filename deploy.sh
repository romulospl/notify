#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/prod.yaml"
ENV_FILE="$ROOT_DIR/.env.production"

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Uso: sudo ./deploy.sh

Valida .env.production, constrói as imagens da aplicação e sobe a stack de
produção nesta VPS: portal, gateway web, API OTLP, Umami, Postgres com backup
contínuo (WAL-G), rollup e Caddy. Dados em STELLYTICS_DATA_DIR (/srv/stellytics).
USAGE
  exit 0
fi

[[ $# -eq 0 ]] || fail "argumento não reconhecido; use --help"
[[ "$EUID" -eq 0 ]] || fail "execute com sudo: sudo ./deploy.sh"
command -v docker >/dev/null 2>&1 || fail "Docker não encontrado; execute sudo ./init.sh primeiro"
command -v python3 >/dev/null 2>&1 || fail "Python 3 não encontrado; execute sudo ./init.sh primeiro"
docker compose version >/dev/null 2>&1 || fail "Docker Compose não encontrado; execute sudo ./init.sh primeiro"
docker info >/dev/null 2>&1 || fail "o daemon Docker não está em execução"
[[ -f "$ENV_FILE" ]] || fail "arquivo ausente: $ENV_FILE (execute sudo ./init.sh primeiro)"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose de produção ausente: $COMPOSE_FILE"

python3 "$ROOT_DIR/infra/scripts/production-env.py" validate "$ENV_FILE"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
printf 'Validando a configuração do Compose...\n'
"${compose[@]}" config --quiet

printf 'Construindo e iniciando a stack de produção...\n'
"${compose[@]}" up -d --build --wait --remove-orphans

# Backup base diário do Postgres (o WAL vai continuamente pelo archive_command).
cat > /etc/systemd/system/stellytics-backup.service <<UNIT
[Unit]
Description=stellytics: backup base do Postgres (WAL-G)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$(command -v docker) compose --env-file $ENV_FILE -f $COMPOSE_FILE exec -T -u postgres postgres stellytics-backup
UNIT
cat > /etc/systemd/system/stellytics-backup.timer <<'UNIT'
[Unit]
Description=stellytics: backup base diário do Postgres

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
UNIT

# Checagem da pilha a cada minuto (infra/scripts/stack-check.py): contêineres,
# arquivamento do WAL, idade do backup base e disco. O resultado vira o
# /healthz/stack do Caddy, que o monitoramento externo sonda.
data_dir="$(sed -n 's/^STELLYTICS_DATA_DIR=//p' "$ENV_FILE" | tail -n 1)"
data_dir="${data_dir:-/srv/stellytics}"
cat > /etc/systemd/system/stellytics-check.service <<UNIT
[Unit]
Description=stellytics: checagem da pilha para o monitoramento externo
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
Description=stellytics: checagem da pilha a cada minuto

[Timer]
OnCalendar=*:*:00
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now stellytics-backup.timer stellytics-check.timer

# Sem backup base no armazenamento (primeiro deploy), não espera as 03:00: a
# checagem acusa a falta dele e a restauração não teria ponto de partida.
if ! "${compose[@]}" exec -T -u postgres postgres wal-g backup-list --json 2>/dev/null | grep -q '"backup_name"'; then
  printf 'Nenhum backup base no armazenamento: iniciando o primeiro em segundo plano.\n'
  systemctl start --no-block stellytics-backup.service
fi

printf '\nEstado dos serviços:\n'
"${compose[@]}" ps
