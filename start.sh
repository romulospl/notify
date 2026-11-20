#!/usr/bin/env bash
# Local development stack helper.
# Usage: ./start.sh [up|restart|down|reset|logs|status] [--umami] [service...]
set -euo pipefail

cd "$(dirname "$0")"

cmd="${1:-up}"
[ $# -gt 0 ] && shift

files=(-f compose.yaml)
services=()
for arg in "$@"; do
  case "$arg" in
    --umami) files+=(-f infra/compose/umami-port.yaml) ;; # Umami UI at 127.0.0.1:3001 (dev only)
    *) services+=("$arg") ;;
  esac
done

dc() { docker compose "${files[@]}" "$@"; }

urls() {
  cat <<'EOF'

Portal:   http://127.0.0.1:3000
Mailpit:  http://127.0.0.1:8025
Gateway:  http://127.0.0.1:3002
Collector OTLP: 127.0.0.1:4317 (gRPC) / 4318 (HTTP)
Postgres: 127.0.0.1:5433

Dev accounts: admin@example.com / admin321admin
              scf@example.org / scf-admin-12345
EOF
}

case "$cmd" in
  up)      dc up -d --build --wait "${services[@]}"; urls ;;
  restart) dc restart "${services[@]}"; urls ;;
  down)    dc down ;;
  reset)   dc down -v; dc up -d --build --wait; urls ;;
  logs)    dc logs -f "${services[@]}" ;;
  status)  dc ps ;;
  *)
    echo "Usage: $0 [up|restart|down|reset|logs|status] [--umami] [service...]" >&2
    exit 1
    ;;
esac
