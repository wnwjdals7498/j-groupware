CREATE FUNCTION jgw_notify_session_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('jgw_session_ends', json_build_object('tenant', OLD.tenant_id, 'hash', OLD.session_hash)::text);
  RETURN NULL;
END;
$$;
CREATE TRIGGER jgw_session_deleted AFTER DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION jgw_notify_session_end();
CREATE TRIGGER jgw_session_roles_changed AFTER UPDATE OF roles ON sessions FOR EACH ROW WHEN (OLD.roles IS DISTINCT FROM NEW.roles) EXECUTE FUNCTION jgw_notify_session_end();
REVOKE ALL ON FUNCTION jgw_notify_session_end() FROM PUBLIC;
