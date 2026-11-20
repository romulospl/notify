#!/usr/bin/env bash
# SCF operator admin on the production server (#19, ADR 0017).
#
# Runs scripts/operator.mjs inside the running portal container, which already
# has DATABASE_URL, SMTP_URL, MAIL_FROM and BETTER_AUTH_URL: no tunnel, and no
# secret leaves the server. Whoever can SSH into the server and use sudo can
# run it; that is the group that controls who is an operator.
#
#   sudo ./operator.sh invite                   # disabled in this version: refuses and sends nothing
#   sudo ./operator.sh list                     # operators and pending invites
#   sudo ./operator.sh uninvite --email <email>
#   sudo ./operator.sh promote  --email <email>
#   sudo ./operator.sh demote   --email <email>
#
# `create` also works, with the password in OPERATOR_PASSWORD (it is passed to
# the container only when set).
set -euo pipefail

if [ "$#" -eq 0 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# The portal container of whichever Compose project runs production.
mapfile -t containers < <(docker ps --filter label=com.docker.compose.service=portal --format '{{.Names}}')
if [ "${#containers[@]}" -ne 1 ]; then
  echo "Expected exactly one running portal container, found ${#containers[@]}: ${containers[*]:-none}." >&2
  exit 1
fi

flags=(-i)
[ -t 0 ] && [ -t 1 ] && flags+=(-t)
[ -n "${OPERATOR_PASSWORD:-}" ] && flags+=(-e OPERATOR_PASSWORD)

exec docker exec "${flags[@]}" "${containers[0]}" node scripts/operator.mjs "$@"
