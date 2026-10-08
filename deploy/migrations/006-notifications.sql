CREATE TABLE notification_services (
 tenant_id text NOT NULL,service text NOT NULL CHECK(service IN ('j-approval','j-talk','j-mail')),
 key_hashes text[] NOT NULL,active boolean NOT NULL,
 PRIMARY KEY(tenant_id,service),CHECK(cardinality(key_hashes)<=2),CHECK(NOT active OR cardinality(key_hashes)>0)
);
CREATE TABLE notifications (
 tenant_id text NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),service text NOT NULL,
 type text NOT NULL,required_role text NOT NULL,target jsonb NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),body text NOT NULL CHECK(octet_length(body)<=1024),
 link text NOT NULL,dedup_key text NOT NULL CHECK(length(dedup_key) BETWEEN 1 AND 256),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,service,dedup_key),FOREIGN KEY(tenant_id,service) REFERENCES notification_services(tenant_id,service)
);
CREATE TABLE notification_reads (
 tenant_id text NOT NULL,notification_id uuid NOT NULL,member_id text NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,notification_id,member_id),FOREIGN KEY(tenant_id,notification_id) REFERENCES notifications(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX notification_order ON notifications(tenant_id,created_at DESC,id DESC);
CREATE INDEX notification_targets ON notifications USING gin(target);
CREATE FUNCTION jgw_notify_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('jgw_notifications',json_build_object('tenant',NEW.tenant_id,'id',NEW.id)::text);
 RETURN NEW;
END $$;
CREATE TRIGGER notification_committed AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION jgw_notify_notification();
REVOKE ALL ON notification_services,notifications,notification_reads FROM PUBLIC;
REVOKE ALL ON FUNCTION jgw_notify_notification() FROM PUBLIC;
