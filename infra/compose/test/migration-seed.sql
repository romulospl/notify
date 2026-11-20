-- Sample data for the migration test (data-migration-test.sh, #54).
-- Runs as superuser on the stellytics database, after the portal migrations and the
-- creation of two users by the administration command. psql variables: alice_email, operator_email,
-- umami_site (ID of a site already created in Umami), key_active, key_revoked,
-- key_archived, key_removed (full ntf_... keys; only the hash goes to the database).
\set ON_ERROR_STOP on

-- SCF operator (the D2 trigger requires that it is not a project member).
UPDATE "user" SET role = 'operator' WHERE email = :'operator_email';

INSERT INTO tenant (id, name, slug, status, status_reason) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Alpha', 'alpha', 'active', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'Beta (removed)', 'beta', 'removed', 'removal test'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'Gamma (pending)', 'gamma', 'pending', NULL);

INSERT INTO tenant_member (tenant_id, user_id, role)
SELECT 'aaaaaaaa-0000-4000-8000-000000000001', id, 'owner' FROM "user" WHERE email = :'alice_email';

INSERT INTO site (id, tenant_id, name, domain, umami_website_id) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Alpha site', 'alpha.example', :'umami_site'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'Alpha docs', 'docs.alpha.example', gen_random_uuid()),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000002', 'Beta site', 'beta.example', gen_random_uuid());

INSERT INTO api_service (id, tenant_id, name, archived_at) VALUES
  ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'alpha-api', NULL),
  ('cccccccc-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'alpha-old-api', now()),
  ('cccccccc-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000002', 'beta-api', NULL);

-- Four keys: only the first should appear in ingest_key_active.
INSERT INTO ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by, revoked_at)
SELECT s, t, substring(k from 5 for 8), sha256(convert_to(k, 'UTF8')), u.id, r
FROM (VALUES
  ('cccccccc-0000-4000-8000-000000000001'::uuid, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid, :'key_active', NULL::timestamptz),
  ('cccccccc-0000-4000-8000-000000000001'::uuid, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid, :'key_revoked', now()),
  ('cccccccc-0000-4000-8000-000000000002'::uuid, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid, :'key_archived', NULL),
  ('cccccccc-0000-4000-8000-000000000003'::uuid, 'aaaaaaaa-0000-4000-8000-000000000002'::uuid, :'key_removed', NULL)
) AS v(s, t, k, r)
CROSS JOIN (SELECT id FROM "user" WHERE email = :'alice_email') u;

INSERT INTO audit_log (actor_user_id, action, tenant_id, details)
SELECT u.id, a, 'aaaaaaaa-0000-4000-8000-000000000002', jsonb_build_object('reason', 'test', 'n', n)
FROM (SELECT id FROM "user" WHERE email = :'operator_email') u,
     (VALUES ('tenant.removed', 1), ('tenant.reactivated', 2), ('tenant.removed', 3)) AS v(a, n);

-- Metrics: 4 days of 1-minute points on 3 routes and 2 statuses (partition of the
-- current month), points from 40 days ago (the default partition, because only the
-- current month and the next 2 have a partition) and one point in the next month.
INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                           request_count, duration_sum, duration_buckets)
SELECT date_trunc('minute', now()) - make_interval(mins => m), 'aaaaaaaa-0000-4000-8000-000000000001',
       'cccccccc-0000-4000-8000-000000000001', r, 'GET', st,
       10 + (m % 7), (10 + (m % 7)) * 0.05,
       ARRAY[1, 2, 3, 2, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, m % 5]::bigint[]
FROM generate_series(10, 4 * 1440, 1) m,
     (VALUES ('/accounts/{address}'), ('/ledgers/{id}'), ('/health')) AS rr(r),
     (VALUES (200::smallint), (500::smallint)) AS ss(st);
INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                           request_count, duration_sum, duration_buckets)
SELECT date_trunc('minute', now() - interval '40 days') + make_interval(mins => m),
       'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001',
       '/old', 'POST', 201, 5, 0.5, ARRAY[0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[]
FROM generate_series(0, 59) m;
INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                           request_count, duration_sum, duration_buckets)
VALUES (date_trunc('month', now()) + interval '1 month 1 hour', 'aaaaaaaa-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000001', '/future', 'GET', 200, 1, 0.1,
        ARRAY[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[]);

-- Real rollup: fills api_metric_1h and api_metric_1d.
SELECT api_metric_maintain(interval '10 days');
