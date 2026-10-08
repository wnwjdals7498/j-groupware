ALTER TABLE notification_services
 ADD COLUMN projection_expires_at timestamptz,
 ADD COLUMN previous_key_expires_at timestamptz;
CREATE TABLE notification_projection_state (
 tenant_id text PRIMARY KEY,
 manifest_revision bigint NOT NULL CHECK(manifest_revision>0),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
 source_checked_at timestamptz
);
REVOKE ALL ON notification_projection_state FROM PUBLIC;
