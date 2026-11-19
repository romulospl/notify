#!/usr/bin/env bash
# Writes the monitoring configuration (ADR 0005) from an env file, then the
# operator starts it with `docker compose up -d --wait` in the same folder.
#
#   infra/monitoring/configure.sh monitoring.env [output-dir]
#
# monitoring.env (keep it 0600, outside git):
#   PORTAL_HOST=app.example.org        INGEST_HOST=e.example.org
#   API_URL=https://otlp.example.org/v1/metrics   (optional; expects 401)
#   ALERT_EMAIL=ops@example.org        SMTP_SMARTHOST=smtp.example.org:587
#   SMTP_FROM=monitor@example.org      SMTP_USERNAME= SMTP_PASSWORD=
#   SMTP_REQUIRE_TLS=true              DEADMAN_URL=   (optional heartbeat URL)
set -euo pipefail

env_file="${1:?usage: configure.sh <env-file> [output-dir]}"
out="${2:-$(cd "$(dirname "$0")" && pwd)}"
set -a; . "$env_file"; set +a
: "${PORTAL_HOST:?}" "${INGEST_HOST:?}" "${ALERT_EMAIL:?}" "${SMTP_SMARTHOST:?}" "${SMTP_FROM:?}"

mkdir -p "$out/prometheus/targets" "$out/alertmanager/secrets"

{
  printf -- '- targets: ["https://%s/api/auth/ok"]\n  labels:\n    component: portal\n' "$PORTAL_HOST"
  printf -- '- targets: ["https://%s/healthz"]\n  labels:\n    component: ingest-web\n' "$INGEST_HOST"
  # Checagem interna da VPS (stellytics-check): backup, WAL, contêineres, disco.
  printf -- '- targets: ["https://%s/healthz/stack"]\n  labels:\n    component: stack\n' "$INGEST_HOST"
  if [ -n "${API_URL:-}" ]; then
    printf -- '- targets: ["%s"]\n  labels:\n    component: ingest-api\n    module: otlp_401\n' "$API_URL"
  fi
} > "$out/prometheus/targets/endpoints.yml"

{
  printf 'global:\n  smtp_smarthost: "%s"\n  smtp_from: "%s"\n' "$SMTP_SMARTHOST" "$SMTP_FROM"
  if [ -n "${SMTP_USERNAME:-}" ]; then
    printf '  smtp_auth_username: "%s"\n  smtp_auth_password_file: /etc/alertmanager/secrets/smtp_password\n' "$SMTP_USERNAME"
  fi
  printf '  smtp_require_tls: %s\n\n' "${SMTP_REQUIRE_TLS:-true}"
  receiver=blackhole; [ -n "${DEADMAN_URL:-}" ] && receiver=deadman
  cat <<YAML
route:
  receiver: email
  group_by: [alertname, component]
  group_wait: 30s
  group_interval: 1m
  repeat_interval: 4h
  routes:
    # The Watchdog goes to the external heartbeat every 5 minutes.
    - matchers: ['alertname="Watchdog"']
      receiver: $receiver
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 5m

receivers:
  - name: email
    email_configs:
      - to: "$ALERT_EMAIL"
        send_resolved: true
  - name: blackhole
YAML
  if [ -n "${DEADMAN_URL:-}" ]; then
    printf '  - name: deadman\n    webhook_configs:\n      - url_file: /etc/alertmanager/secrets/deadman_url\n        send_resolved: false\n'
  fi
  cat <<'YAML'

inhibit_rules:
  # Without the blackbox, EndpointDown and ProbeFailing say nothing new.
  - source_matchers: ['alertname="ProberDown"']
    target_matchers: ['alertname=~"EndpointDown|ProbeFailing"']
  # With a public endpoint down, the stack check says nothing new either.
  - source_matchers: ['alertname="EndpointDown"']
    target_matchers: ['alertname="StackUnhealthy"']
YAML
} > "$out/alertmanager/alertmanager.yml"

printf '%s' "${SMTP_PASSWORD:-}" > "$out/alertmanager/secrets/smtp_password"
printf '%s' "${DEADMAN_URL:-}" > "$out/alertmanager/secrets/deadman_url"
# Alertmanager runs as nobody (65534).
if [ "$(id -u)" = 0 ]; then
  chown -R 65534:65534 "$out/alertmanager/secrets"
  chmod 0700 "$out/alertmanager/secrets"; chmod 0400 "$out/alertmanager/secrets/"*
else
  chmod -R a+rX "$out/alertmanager"
fi
echo "monitoring: configuration written to $out"
