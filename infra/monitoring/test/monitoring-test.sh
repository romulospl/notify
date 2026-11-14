#!/usr/bin/env bash
# Teste do monitoramento externo (#15), localmente e no job `monitoring` do CI.
#
# Sobe infra/monitoring com a configuração gerada pelo mesmo template do
# Ansible e confere:
# 1. Prometheus, regras e Alertmanager com configuração válida;
# 2. o sinal de vida (Watchdog) chega ao receptor externo;
# 3. quando um alvo cai, chega o e-mail de alerta (EndpointDown);
# 4. quando volta, chega o e-mail de resolvido.
#
# Uso, da raiz do repositório: infra/monitoring/test/monitoring-test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
project=notify-monitortest
work=$(mktemp -d "${TMPDIR:-/tmp}/notify-monitortest.XXXXXX")
cp -R "$root/monitoring/." "$work/"
rm -rf "$work/test"
mkdir -p "$work/prometheus/targets" "$work/alertmanager/secrets"

cat > "$work/prometheus/targets/endpoints.yml" <<'EOT'
- targets: ["http://target:8080/"]
  labels:
    component: portal
EOT
echo -n "http://deadman:8080/ping" > "$work/alertmanager/secrets/deadman_url"
: > "$work/alertmanager/secrets/smtp_password"
chmod -R a+rX "$work"

# alertmanager.yml a partir do template do Ansible (Jinja com trim_blocks, como o Ansible).
docker run --rm -v "$root/ansible/roles/monitoring/templates:/t:ro" -v "$work/alertmanager:/out" \
  python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 sh -c '
    pip install -q --root-user-action=ignore jinja2==3.1.6 pyyaml==6.0.3 >/dev/null 2>&1 &&
    python3 -c "
import jinja2
env = jinja2.Environment(loader=jinja2.FileSystemLoader(\"/t\"), trim_blocks=True, undefined=jinja2.StrictUndefined)
out = env.get_template(\"alertmanager.yml.j2\").render(
    monitor_smtp_smarthost=\"mailpit:1025\", monitor_smtp_from=\"monitor@example.org\",
    monitor_smtp_username=\"\", monitor_smtp_require_tls=False,
    monitor_alert_email=\"ops@example.org\", monitor_deadman_url=\"http://deadman:8080/ping\")
open(\"/out/alertmanager.yml\", \"w\").write(out)
# O sinal de vida precisa sair a cada 5 minutos: o serviço externo avisa
# quando ele para de chegar.
import yaml
routes = yaml.safe_load(out)[\"route\"][\"routes\"]
watchdog = [r for r in routes if r[\"matchers\"] == [\"alertname=\\\"Watchdog\\\"\"]]
assert len(watchdog) == 1 and watchdog[0][\"receiver\"] == \"deadman\", routes
assert watchdog[0][\"repeat_interval\"] == \"5m\", watchdog
"'

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
