-- Written by hand (drizzle-kit generate --custom). E2 spec, sections 3 and 4 (D4).
--
-- Views read by the web gateway and the collector, with minimum privileges for
-- the stellytics_ingest and stellytics_collector users. Both users are created outside
-- the migrations, by whoever administers the server (infra/compose/postgres/init/
-- 02-ingest-roles.sh in the local environment), because creating a role requires superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stellytics_ingest')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stellytics_collector') THEN
    RAISE EXCEPTION 'The stellytics_ingest and stellytics_collector roles must exist before this migration. Run infra/compose/postgres/init/02-ingest-roles.sh.';
  END IF;
END
$$;
--> statement-breakpoint

-- Web gateway (#61): the site's ID in Umami and whether it accepts ingestion now.
-- The view runs with the owner's privileges, so the reader does not need access
-- to the tables.
CREATE VIEW "ingest_site" AS
SELECT
  s.umami_website_id,
  (s.archived_at IS NULL AND t.status = 'active') AS accepts_ingest
FROM site s
JOIN tenant t ON t.id = s.tenant_id;
--> statement-breakpoint

-- Collector (#30): only the keys valid now (not revoked, service not
-- archived, tenant active). The collector looks up by prefix and compares the hash.
CREATE VIEW "ingest_key_active" AS
SELECT
  k.prefix,
  k.key_hash,
  k.tenant_id,
  k.api_service_id,
  s.name AS service_name
FROM ingest_key k
JOIN api_service s ON s.id = k.api_service_id
JOIN tenant t ON t.id = k.tenant_id
WHERE k.revoked_at IS NULL
  AND s.archived_at IS NULL
  AND t.status = 'active';
--> statement-breakpoint

REVOKE ALL ON "ingest_site", "ingest_key_active" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON "ingest_site" TO stellytics_ingest;
--> statement-breakpoint
-- The INSERT on the metric tables comes in E5, together with the tables.
GRANT SELECT ON "ingest_key_active" TO stellytics_collector;
--> statement-breakpoint

-- audit_log is insert-only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is insert-only';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
