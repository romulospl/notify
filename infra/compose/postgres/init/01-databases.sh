#!/bin/sh
# Creates a user and a database for each consumer: umami (managed by Umami)
# and stellytics (tenants, keys and API metrics). Runs only with an empty volume.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v umami_pw="$UMAMI_DB_PASSWORD" -v stellytics_pw="$STELLYTICS_DB_PASSWORD" <<'SQL'
CREATE ROLE umami LOGIN PASSWORD :'umami_pw';
CREATE DATABASE umami OWNER umami;
CREATE ROLE stellytics LOGIN PASSWORD :'stellytics_pw';
CREATE DATABASE stellytics OWNER stellytics;
REVOKE ALL ON DATABASE umami FROM PUBLIC;
REVOKE ALL ON DATABASE stellytics FROM PUBLIC;
SQL
