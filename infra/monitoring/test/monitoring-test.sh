#!/usr/bin/env bash
# Teste do monitoramento externo (#15), localmente e no job `monitoring` do CI.
#
# Sobe infra/monitoring com a configuração gerada por configure.sh e confere:
# 1. Prometheus, regras e Alertmanager com configuração válida;
# 2. o sinal de vida (Watchdog) chega ao receptor externo;
# 3. quando um alvo cai, chega o e-mail de alerta (EndpointDown);
# 4. quando volta, chega o e-mail de resolvido.
#
# Uso, da raiz do repositório: infra/monitoring/test/monitoring-test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
project=stellytics-monitortest
work=$(mktemp -d "${TMPDIR:-/tmp}/stellytics-monitortest.XXXXXX")
cp -R "$root/monitoring/." "$work/"
rm -rf "$work/test"
cat > "$work/monitoring.env" <<'EOT'
PORTAL_HOST=portal.invalid
INGEST_HOST=ingest.invalid
ALERT_EMAIL=ops@example.org
SMTP_SMARTHOST=mailpit:1025
SMTP_FROM=monitor@example.org
SMTP_REQUIRE_TLS=false
DEADMAN_URL=http://deadman:8080/ping
EOT
"$root/monitoring/configure.sh" "$work/monitoring.env" "$work" >/dev/null

cat > "$work/prometheus/targets/endpoints.yml" <<'EOT'
- targets: ["http://target:8080/"]
  labels:
    component: portal
EOT
chmod -R a+rX "$work"

# O sinal de vida precisa sair a cada 5 minutos: o serviço externo avisa
# quando ele para de chegar.
grep -A4 'alertname="Watchdog"' "$work/alertmanager/alertmanager.yml" | grep -q 'receiver: deadman' || { echo "FALHOU: Watchdog sem deadman" >&2; exit 1; }
grep -A4 'alertname="Watchdog"' "$work/alertmanager/alertmanager.yml" | grep -q 'repeat_interval: 5m' || { echo "FALHOU: Watchdog sem 5m" >&2; exit 1; }

export PROMETHEUS_PORT=19090 ALERTMANAGER_PORT=19093 MAILPIT_TEST_PORT=18025
compose() { docker compose -p "$project" -f "$work/compose.yaml" -f "$root/monitoring/test/monitoring-test.yaml" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --tail 60 prometheus alertmanager >&2 || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
fail() { echo "FALHOU: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
wait_for() { # segundos, descrição, comando
  local limit=$1 what=$2; shift 2
  for _ in $(seq 1 "$limit"); do "$@" && return 0; sleep 1; done
  fail "$what (esperou ${limit}s)"
}

compose up -d --wait

# 1. Configuração válida e regras testadas (promtool test rules).
compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml >/dev/null
docker run --rm -v "$root/monitoring:/m:ro" -w /m/test --entrypoint promtool \
  prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2 \
  test rules alerts.test.yml >/dev/null
compose exec -T alertmanager amtool check-config /etc/alertmanager/alertmanager.yml >/dev/null
ok "configuração do Prometheus e do Alertmanager; regras e intervalo do sinal de vida testados"

query() { curl -fsS --get "http://127.0.0.1:19090/api/v1/query" --data-urlencode "query=$1" | python3 -c 'import sys,json; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else "")'; }
probe_is() { [ "$(query 'probe_success{component="portal"}')" = "$1" ]; }
wait_for 90 "o alvo não ficou verde no Prometheus" probe_is 1
ok "o blackbox testa o alvo"

# 2. Sinal de vida.
deadman_called() { compose logs --no-color deadman 2>/dev/null | grep -q '"uri":"/ping"'; }
wait_for 90 "o Watchdog não chegou ao receptor do sinal de vida" deadman_called
ok "sinal de vida chega ao receptor externo"

# 3. Alvo fora do ar: e-mail de alerta.
mail_with() { curl -fsS "http://127.0.0.1:18025/api/v1/search?query=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")" | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin)["messages_count"] > 0 else 1)'; }
compose stop target >/dev/null
wait_for 60 "o Prometheus não viu o alvo cair" probe_is 0
wait_for 180 "o e-mail de alerta não chegou" mail_with 'subject:"[FIRING:1] EndpointDown"'
mail_with 'portal is down' || fail "o e-mail de alerta não diz qual componente caiu"
ok "alerta por e-mail quando o alvo cai"

# 4. Alvo de volta: e-mail de resolvido.
compose start target >/dev/null
wait_for 60 "o Prometheus não viu o alvo voltar" probe_is 1
wait_for 180 "o e-mail de resolvido não chegou" mail_with 'subject:"[RESOLVED] EndpointDown"'
ok "e-mail de resolvido quando o alvo volta"

echo "monitoramento: tudo certo"
