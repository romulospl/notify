#!/bin/sh
# Creates the stellytics database users used by the web gateway (stellytics_ingest) and
# by the collector (stellytics_collector), with minimal privileges (E2 spec, D4).
# The views they read and the GRANTs come from the portal migrations.
#
# In Compose it runs only with an empty volume, after 01-databases.sh. For a
# volume that already exists (without erasing the data):
#   docker compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh
# CI uses the same script against the service Postgres (PGHOST etc.).
# Idempotent: if the role already exists, it only updates the password.
set -eu

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v ingest_pw="${STELLYTICS_INGEST_DB_PASSWORD:-stellytics_ingest}" \
  -v collector_pw="${STELLYTICS_COLLECTOR_DB_PASSWORD:-stellytics_collector}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', r)
FROM unnest(ARRAY['stellytics_ingest', 'stellytics_collector']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec
ALTER ROLE stellytics_ingest LOGIN PASSWORD :'ingest_pw';
ALTER ROLE stellytics_collector LOGIN PASSWORD :'collector_pw';
GRANT CONNECT ON DATABASE stellytics TO stellytics_ingest, stellytics_collector;
-- Lets the portal assume these roles (SET ROLE) in the permission tests, without
-- inheriting anything from them. The portal already owns the tables, so it gains no new access.
GRANT stellytics_ingest, stellytics_collector TO stellytics WITH INHERIT FALSE, SET TRUE;
SQL
