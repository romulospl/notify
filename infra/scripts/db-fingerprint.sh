#!/usr/bin/env bash
# Fingerprint of the stellytics and umami databases (#54, docs/handover.md).
#
# Prints, as stable text, everything the data migration must preserve:
# rows and checksum of each table (partitions included), sequence values,
# schema hash (`pg_dump --schema-only`: tables, partitions, functions,
# triggers, views, GRANTs and owners), and roles, memberships and privileges of
# the database users. Prints no passwords, password hashes or tenant
# data: only counts and hashes. Run on the origin and the destination and compare with
# `diff`.
#
#   COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' infra/scripts/db-fingerprint.sh > fp.txt
#
# The COMPOSE default is that of the production VM (at the root of the clone).
# Uses the Compose `postgres` through the container's socket, as superuser.
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod.yaml}"
# `< /dev/null`: `docker compose exec -T` reads standard input and, inside a
# `while read`, would swallow the table list (only the first would be checked).
pg() { $COMPOSE exec -T -u postgres postgres "$@" < /dev/null; }
q() { pg psql -X -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

for db in stellytics umami; do
  echo "== database $db"
  echo "-- tables (schema.table rows checksum)"
  q "$db" "select format('%I.%I', n.nspname, c.relname)
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
             and n.nspname not like 'pg_toast%'
           order by 1" |
    while read -r tbl; do
      # Per-row checksum, sorted: does not depend on the physical order or on the
      # size of the aggregated text.
      row=$(q "$db" "select count(*), coalesce(md5(string_agg(h, '' order by h)), 'empty')
                     from (select md5(t::text) as h from $tbl t) s")
      echo "$tbl ${row%%|*} ${row##*|}"
    done
  echo "-- sequences (name last_value)"
  q "$db" "select format('%I.%I', schemaname, sequencename), coalesce(last_value::text, 'never')
           from pg_sequences order by 1"
  echo "-- schema (sha256 of pg_dump --schema-only)"
  # pg_dump 17 puts a random token (`\restrict` and `\unrestrict`) in each
  # output; without removing it, two dumps of the same database never give the same hash.
  pg pg_dump -s -d "$db" | grep -v -E '^\\(un)?restrict ' | sha256sum | cut -d' ' -f1
  echo "-- object count (type n)"
  q "$db" "select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'drizzle')
           union all select 'triggers', count(*) from pg_trigger where not tgisinternal
           union all select 'views', count(*) from pg_views where schemaname = 'public'
           union all select 'inheritance (partitions and indexes)', count(*) from pg_inherits
           union all select 'extensions', count(*) from pg_extension order by 1"
  echo "-- extensions"
  q "$db" "select extname || ' ' || extversion from pg_extension order by 1"
done

echo "== roles (no passwords)"
q postgres "select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
            from pg_roles where rolname in ('umami', 'stellytics', 'stellytics_ingest', 'stellytics_collector') order by 1"
echo "-- memberships (role member inherit set)"
q postgres "select r.rolname, m.rolname, a.inherit_option, a.set_option
            from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
            where r.rolname like 'stellytics%' or m.rolname like 'stellytics%' order by 1, 2"
echo "-- database ACLs"
q postgres "select datname, coalesce(datacl::text, 'default'), pg_get_userbyid(datdba)
            from pg_database where datname in ('stellytics', 'umami') order by 1"
echo "-- read privileges (role object privilege)"
q stellytics "select r, o, p, has_table_privilege(r, o, p)
          from (values ('stellytics_ingest'), ('stellytics_collector')) a(r),
               (values ('ingest_site'), ('ingest_key_active'), ('tenant'), ('ingest_key'), ('api_metric_1m'),
                       ('api_metric_1h'), ('operator_api_key'), ('audit_log')) b(o),
               (values ('SELECT'), ('INSERT'), ('UPDATE')) c(p)
          order by 1, 2, 3"
