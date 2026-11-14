#!/usr/bin/env bash
# Túnel SSH de administração para a produção (#14, docs/deploy.md).
#
# Leva o Postgres e o Umami da VM para portas locais, sem publicar nada na
# internet: o Postgres escuta só no loopback da VM e o Umami só na rede
# interna do Compose (IP fixo 172.30.0.20, ver infra/compose/prod.yaml).
#
#   infra/scripts/admin-tunnel.sh <ip-da-vm>
#
# Com o túnel aberto, em outro terminal:
#   Postgres: postgresql://notify:<senha>@127.0.0.1:15432/notify
#   Umami:    http://127.0.0.1:13001 (interface e API)
# Ctrl+C fecha o túnel.
set -euo pipefail
host="${1:?uso: admin-tunnel.sh <ip-da-vm>}"
echo "Postgres em 127.0.0.1:15432 e Umami em http://127.0.0.1:13001 (Ctrl+C fecha)."
exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:15432:127.0.0.1:5432 \
  -L 127.0.0.1:13001:172.30.0.20:3000 \
  "root@$host"
