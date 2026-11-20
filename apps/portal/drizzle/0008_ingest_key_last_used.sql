-- Written by hand (drizzle-kit generate --custom). Records the last use of an
-- ingest key (ingest_key.last_used_on).
--
-- The collector (stellytics_collector) authenticates the key; it only reads the
-- ingest_key_active view and has no access to the table. Instead of granting
-- per-column UPDATE on the table (which would also require SELECT on prefix,
-- revoked_at and the other columns for the WHERE, opening up the reading of
-- revoked keys and of key_hash), the collector gets only EXECUTE on this
-- function. It runs as the owner (stellytics), writes a single column, and only
-- for a key that the ingest_key_active view considers active (not revoked,
-- service not archived, tenant active). The day is the database's UTC day, and
-- the function does not write again if the date is already today's.
CREATE OR REPLACE FUNCTION public.ingest_key_touch(p_prefix text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE public.ingest_key k
  SET last_used_on = (now() AT TIME ZONE 'UTC')::date
  WHERE k.prefix = p_prefix
    AND k.last_used_on IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date
    AND EXISTS (SELECT 1 FROM public.ingest_key_active a WHERE a.prefix = k.prefix);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.ingest_key_touch(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ingest_key_touch(text) TO stellytics_collector;
