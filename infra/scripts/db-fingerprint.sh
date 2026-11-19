#!/usr/bin/env bash
# Impressão digital dos bancos stellytics e umami (#54, docs/transferencia.md).
#
# Imprime, em texto estável, tudo o que a migração de dados precisa preservar:
# linhas e checksum de cada tabela (partições inclusas), valores das sequências,
# hash do esquema (`pg_dump --schema-only`: tabelas, partições, funções,
# gatilhos, visões, GRANTs e donos), e papéis, filiações e permissões dos
# usuários do banco. Não imprime senhas, hashes de senha nem dados de
# tenants: só contagens e hashes. Rode na origem e no destino e compare com
# `diff`.
#
#   COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' infra/scripts/db-fingerprint.sh > fp.txt
#
# O padrão de COMPOSE é o da VM de produção (na raiz do clone).
# Usa o `postgres` do Compose pelo socket do contêiner, como superusuário.
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod.yaml}"
# `< /dev/null`: o `docker compose exec -T` lê a entrada padrão e, dentro de um
# `while read`, engoliria a lista de tabelas (só a primeira seria conferida).
pg() { $COMPOSE exec -T -u postgres postgres "$@" < /dev/null; }
q() { pg psql -X -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

for db in stellytics umami; do
  echo "== banco $db"
  echo "-- tabelas (esquema.tabela linhas checksum)"
  q "$db" "select format('%I.%I', n.nspname, c.relname)
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
             and n.nspname not like 'pg_toast%'
           order by 1" |
    while read -r tbl; do
      # Checksum por linha, ordenado: não depende da ordem física nem do
      # tamanho do texto agregado.
      row=$(q "$db" "select count(*), coalesce(md5(string_agg(h, '' order by h)), 'vazia')
                     from (select md5(t::text) as h from $tbl t) s")
      echo "$tbl ${row%%|*} ${row##*|}"
    done
  echo "-- sequências (nome último_valor)"
  q "$db" "select format('%I.%I', schemaname, sequencename), coalesce(last_value::text, 'nunca')
           from pg_sequences order by 1"
  echo "-- esquema (sha256 de pg_dump --schema-only)"
  # O pg_dump 17 põe um token aleatório (`\restrict` e `\unrestrict`) em cada
  # saída; sem tirá-lo, dois dumps do mesmo banco nunca dão o mesmo hash.
  pg pg_dump -s -d "$db" | grep -v -E '^\\(un)?restrict ' | sha256sum | cut -d' ' -f1
  echo "-- contagem de objetos (tipo n)"
  q "$db" "select 'funções', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'drizzle')
           union all select 'gatilhos', count(*) from pg_trigger where not tgisinternal
           union all select 'visões', count(*) from pg_views where schemaname = 'public'
           union all select 'herança (partições e índices)', count(*) from pg_inherits
           union all select 'extensões', count(*) from pg_extension order by 1"
  echo "-- extensões"
  q "$db" "select extname || ' ' || extversion from pg_extension order by 1"
done

echo "== papéis (sem senhas)"
q postgres "select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
            from pg_roles where rolname in ('umami', 'stellytics', 'stellytics_ingest', 'stellytics_collector') order by 1"
echo "-- filiações (papel membro inherit set)"
q postgres "select r.rolname, m.rolname, a.inherit_option, a.set_option
            from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
            where r.rolname like 'stellytics%' or m.rolname like 'stellytics%' order by 1, 2"
echo "-- ACL dos bancos"
q postgres "select datname, coalesce(datacl::text, 'padrão'), pg_get_userbyid(datdba)
            from pg_database where datname in ('stellytics', 'umami') order by 1"
echo "-- permissões de leitura (papel objeto permissão)"
q stellytics "select r, o, p, has_table_privilege(r, o, p)
          from (values ('stellytics_ingest'), ('stellytics_collector')) a(r),
               (values ('ingest_site'), ('ingest_key_active'), ('tenant'), ('ingest_key'), ('api_metric_1m'),
                       ('api_metric_1h'), ('operator_api_key'), ('audit_log')) b(o),
               (values ('SELECT'), ('INSERT'), ('UPDATE')) c(p)
          order by 1, 2, 3"
