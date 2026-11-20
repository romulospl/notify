-- Written by hand (drizzle-kit generate --custom). E2 spec, D2 (#19).
--
-- An SCF operator is not a tenant member. The database rejects both ways of
-- breaking the rule: putting an operator in a tenant and promoting a member
-- to operator. It is a second barrier; the portal and the administration
-- script already check first.
CREATE FUNCTION operator_not_member() RETURNS trigger
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
CREATE TRIGGER tenant_member_not_operator
BEFORE INSERT OR UPDATE OF user_id ON tenant_member
FOR EACH ROW EXECUTE FUNCTION operator_not_member();
--> statement-breakpoint
CREATE TRIGGER user_operator_not_member
BEFORE UPDATE OF role ON "user"
FOR EACH ROW EXECUTE FUNCTION operator_not_member();
