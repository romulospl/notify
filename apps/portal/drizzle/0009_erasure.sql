-- Written by hand (drizzle-kit generate --custom). Right to erasure (#154).
--
-- Two pieces: erase a tenant's API metrics at once and allow the only change
-- the audit_log accepts after an insert: replacing `actor_user_id` with the
-- erasure marker, when the account is deleted.

-- Deletes all of a tenant's rows in the three metric tables, partition by
-- partition (the (tenant_id, bucket_start) index serves each one). It is
-- stronger than retention by age (api_metric_drop_partitions), which drops
-- whole partitions: here the granularity is the tenant. The caller is the
-- portal (owner of the tables) in the erasure flow.
CREATE FUNCTION api_metric_purge_tenant(target uuid) RETURNS void
LANGUAGE sql AS $$
  DELETE FROM api_metric_1m WHERE tenant_id = target;
  DELETE FROM api_metric_1h WHERE tenant_id = target;
  DELETE FROM api_metric_1d WHERE tenant_id = target;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION api_metric_purge_tenant(uuid) FROM PUBLIC;
--> statement-breakpoint

-- The audit_log stays insert-only for everything, except one exact change:
-- replacing an existing `actor_user_id` with the erasure marker, without
-- touching any other column. That is what account erasure runs
-- (ANONYMIZED_ACTOR in src/lib/data/erasure.ts): the actions stay in the
-- history, but no longer point to the person, whose row leaves the database.
-- Any other UPDATE, DELETE and TRUNCATE are still rejected, as in 0002.
CREATE FUNCTION audit_log_erasure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.at IS NOT DISTINCT FROM OLD.at
     AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.details IS NOT DISTINCT FROM OLD.details
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.actor_user_id = '[erased]' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is insert-only; the only accepted change replaces actor_user_id with the erasure marker';
  END IF;
  RAISE EXCEPTION 'audit_log is insert-only';
END
$$;
--> statement-breakpoint
DROP TRIGGER audit_log_append_only ON "audit_log";
--> statement-breakpoint
-- The trigger becomes per row so it can compare OLD and NEW. The TRUNCATE
-- one stays per statement with the original function from 0002.
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION audit_log_erasure_guard();
