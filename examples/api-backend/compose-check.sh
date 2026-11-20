#!/bin/sh
# Checks the example backend in Compose (#35): creates a tenant with an ingest
# key, starts infra/compose/api-example.yaml, makes requests and waits for the
# rows in api_metric_1m. Run from the repository root, with compose.yaml up.
# Deletes the tenant at the end.
#
# End to end of the API pipeline (#36): also checks status, latency (buckets
# adding up to the count) and service; sends straight to the collector a trace
# and a log claiming to be from another tenant and fails if the metric lands in
# the wrong tenant or if the trace/log marker shows up in a text column of the
# stellytics database.
set -eu

psql() { docker compose exec -T postgres psql -U postgres -d stellytics -v ON_ERROR_STOP=1 -Atq "$@"; }

suffix=$({ tr -dc 'a-z0-9' </dev/urandom 2>/dev/null; } | head -c 10)
prefix=$({ tr -dc 'a-z2-7' </dev/urandom 2>/dev/null; } | head -c 8)
secret=$({ tr -dc 'A-Za-z0-9_-' </dev/urandom 2>/dev/null; } | head -c 43)
key="ntf_${prefix}_${secret}"

tenant=$(psql -c "
  INSERT INTO \"user\" (id, name, email, email_verified)
    VALUES ('api-example-$suffix', 'api-example', 'api-example-$suffix@example.invalid', true);
  INSERT INTO tenant (name, slug, status) VALUES ('api-example-$suffix', 'api-example-$suffix', 'active') RETURNING id;")
service=$(psql -c "INSERT INTO api_service (tenant_id, name) VALUES ('$tenant', 'example') RETURNING id")
psql -c "INSERT INTO ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by)
  VALUES ('$service', '$tenant', '$prefix', sha256(convert_to('$key', 'UTF8')), 'api-example-$suffix')"

# Second service of the same tenant, with spans only (D9 ignores spans from a
# service that already sends the metric).
prefix2=$({ tr -dc 'a-z2-7' </dev/urandom 2>/dev/null; } | head -c 8)
key2="ntf_${prefix2}_${secret}"
service2=$(psql -c "INSERT INTO api_service (tenant_id, name) VALUES ('$tenant', 'spans') RETURNING id")
psql -c "INSERT INTO ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by)
  VALUES ('$service2', '$tenant', '$prefix2', sha256(convert_to('$key2', 'UTF8')), 'api-example-$suffix')"
decoy=$(psql -c "INSERT INTO tenant (name, slug, status) VALUES ('decoy-$suffix', 'decoy-$suffix', 'active') RETURNING id")

cleanup() {
  STELLYTICS_INGEST_KEY=x docker compose -f compose.yaml -f infra/compose/api-example.yaml \
    rm -sf example-api tenant-otelcol >/dev/null 2>&1 || true
  psql -c "DELETE FROM api_metric_1m WHERE tenant_id = '$tenant';
    DELETE FROM ingest_key WHERE tenant_id = '$tenant';
    DELETE FROM api_service WHERE tenant_id = '$tenant';
    DELETE FROM api_metric_1m WHERE tenant_id = '$decoy';
    DELETE FROM tenant WHERE id IN ('$tenant', '$decoy');
    DELETE FROM \"user\" WHERE id = 'api-example-$suffix';" || true
}
trap cleanup EXIT

STELLYTICS_INGEST_KEY="$key" docker compose -f compose.yaml -f infra/compose/api-example.yaml \
  up -d --build --no-deps --wait --wait-timeout 180 example-api tenant-otelcol

base=http://127.0.0.1:${EXAMPLE_API_PORT:-4010}
for _ in 1 2 3; do
  curl -fsS "$base/accounts/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" >/dev/null
  curl -fsS "$base/ledgers/123" >/dev/null
  curl -s -o /dev/null "$base/x/42"
done

query="SELECT coalesce(sum(request_count), 0) FROM api_metric_1m WHERE tenant_id = '$tenant'"
for _ in $(seq 1 30); do
  total=$(psql -c "$query")
  [ "$total" -ge 9 ] && break
  sleep 2
done
psql -c "SELECT route, method, status_code, request_count FROM api_metric_1m WHERE tenant_id = '$tenant' ORDER BY route"
if [ "$total" -lt 9 ]; then
  echo "expected 9 requests in api_metric_1m, found $total"
  docker compose -f compose.yaml -f infra/compose/api-example.yaml logs --tail 50 tenant-otelcol example-api || true
  exit 1
fi
# The route with no known pattern was normalized by the stellytics collector.
psql -c "SELECT count(*) FROM api_metric_1m WHERE tenant_id = '$tenant' AND route = '/x/{id}' AND status_code = 404" | grep -qx 1
# Right status and latency: the buckets of each row add up to the count.
psql -c "SELECT count(*) FROM api_metric_1m WHERE tenant_id = '$tenant' AND route = '/ledgers/{sequence}' AND status_code = 200 AND request_count = 3" | grep -qx 1
psql -c "SELECT count(*) FROM api_metric_1m WHERE tenant_id = '$tenant' AND api_service_id = '$service'
  AND ( duration_sum <= 0
       OR (SELECT sum(b) FROM unnest(duration_buckets) b) <> request_count)" | grep -qx 0

# Trace and log sent straight to the collector claiming to be from the decoy tenant.
marker="e2emarker$suffix"
trace=5b8efff798038103d269b633813fc60c
now=$(date +%s)000000000
claim='{"key":"stellytics.tenant.id","value":{"stringValue":"'$decoy'"}},{"key":"service.name","value":{"stringValue":"'$marker'"}}'
otlp=http://127.0.0.1:${COLLECTOR_HTTP_PORT:-4318}
curl -fsS -H "Authorization: Bearer $key2" -H 'Content-Type: application/json' "$otlp/v1/traces" -d '{"resourceSpans":[{"resource":{"attributes":['"$claim"']},"scopeSpans":[{"spans":[{"traceId":"'$trace'","spanId":"eee19b7ec3c1b174","name":"'$marker'","kind":2,"startTimeUnixNano":"'$now'","endTimeUnixNano":"'$now'","attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/'$marker'/{id}"}},{"key":"http.response.status_code","value":{"intValue":"201"}},{"key":"stellytics.tenant.id","value":{"stringValue":"'$decoy'"}}]}]}]}]}' >/dev/null
curl -fsS -H "Authorization: Bearer $key2" -H 'Content-Type: application/json' "$otlp/v1/logs" -d '{"resourceLogs":[{"resource":{"attributes":['"$claim"']},"scopeLogs":[{"logRecords":[{"timeUnixNano":"'$now'","body":{"stringValue":"'$marker'-log"}}]}]}]}' >/dev/null

for _ in $(seq 1 30); do
  n=$(psql -c "SELECT count(*) FROM api_metric_1m WHERE route = '/$marker/{id}'")
  [ "$n" -ge 1 ] && break
  sleep 2
done
# The span metric exists and stayed in the key's tenant, never in the decoy.
psql -c "SELECT count(*) FROM api_metric_1m WHERE route = '/$marker/{id}' AND tenant_id = '$tenant' AND api_service_id = '$service2' AND status_code = 201" | grep -qx 1 \
  || { echo "the span metric is not in the key's tenant"; exit 1; }
psql -c "SELECT count(*) FROM api_metric_1m WHERE tenant_id = '$decoy'" | grep -qx 0 \
  || { echo "metric attributed to the tenant claimed by the client"; exit 1; }

# No trace, span or log persisted: the marker (span name, service.name, log
# body) and the trace ID show up in no text column outside the api_metric_*
# tables (where only the aggregated route may contain the marker).
psql -c "CREATE TEMP TABLE IF NOT EXISTS e2e_found (n bigint);
DO \$\$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN SELECT table_schema, table_name, column_name FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND data_type IN ('text', 'character varying', 'jsonb', 'json')
      AND table_name NOT LIKE 'api_metric%'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text LIKE %L OR %I::text LIKE %L',
      r.table_schema, r.table_name, r.column_name, '%$marker%', r.column_name, '%$trace%') INTO n;
    IF n > 0 THEN RAISE WARNING 'found in %.%.%', r.table_schema, r.table_name, r.column_name; total := total + n; END IF;
  END LOOP;
  IF total > 0 THEN RAISE EXCEPTION 'trace/span/log persisted (% rows)', total; END IF;
END \$\$;"
echo "ok: $total requests, right tenant, no trace/log persisted"
