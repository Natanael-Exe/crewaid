-- A missing row cannot be locked. Inserts and retention serialize on its identity.
CREATE FUNCTION lock_workspace_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(5390040, hashtext(NEW.id));
  RETURN NEW;
END;
$$;
CREATE TRIGGER sandbox_workspace_identity BEFORE INSERT OR UPDATE OF id ON "Sandbox"
  FOR EACH ROW EXECUTE FUNCTION lock_workspace_identity();
