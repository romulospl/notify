#!/usr/bin/env bash
# SSH admin tunnel to production (#14, docs/deploy.md).
#
# Brings the VM's Postgres and Umami to local ports, without publishing anything on
# the internet: Postgres listens only on the VM's loopback and Umami only on the
# Compose internal network (fixed IP 172.30.0.20, see infra/compose/prod.yaml).
#
#   infra/scripts/admin-tunnel.sh <vm-ip>
#
# With the tunnel open, in another terminal:
#   Postgres: postgresql://stellytics:<password>@127.0.0.1:15432/stellytics
#   Umami:    http://127.0.0.1:13001 (UI and API)
# Ctrl+C closes the tunnel.
set -euo pipefail
host="${1:?usage: admin-tunnel.sh <vm-ip>}"
echo "Postgres at 127.0.0.1:15432 and Umami at http://127.0.0.1:13001 (Ctrl+C closes)."
exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:15432:127.0.0.1:5432 \
  -L 127.0.0.1:13001:172.30.0.20:3000 \
  "root@$host"
