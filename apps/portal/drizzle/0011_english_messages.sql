-- Written by hand (drizzle-kit generate --custom).
--
-- The trigger functions of 0002, 0003 and 0009 were first created with
-- Portuguese error messages and a Portuguese erasure marker. Those migrations
-- now carry English text, but a database that already ran them keeps the old
-- function bodies. This migration replaces the three functions so that every
-- database ends up with the same English text, and rewrites the marker in the
-- audit_log rows that were anonymized before it. On a fresh database it
-- changes nothing.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is insert-only';
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION operator_not_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tenant_member' THEN
    IF EXISTS (SELECT 1 FROM "user" WHERE id = NEW.user_id AND role = 'operator') THEN
      RAISE EXCEPTION 'an operator cannot be a tenant member (D2)' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.role = 'operator' AND OLD.role IS DISTINCT FROM 'operator' THEN
    IF EXISTS (SELECT 1 FROM tenant_member WHERE user_id = NEW.id) THEN
      RAISE EXCEPTION 'a tenant member cannot become an operator (D2)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_erasure_guard() RETURNS trigger
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
-- Rows anonymized before this migration carry the old marker. It was the only
-- bracketed value the guard ever accepted (user ids have no brackets), so the
-- pattern below matches exactly those rows. The guard above accepts the
-- change: only actor_user_id moves, and it moves to the marker.
UPDATE "audit_log"
SET actor_user_id = '[erased]'
WHERE actor_user_id LIKE '[%]' AND actor_user_id <> '[erased]';
