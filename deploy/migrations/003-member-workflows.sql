ALTER TABLE login_flows ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE member_session_ends (
  tenant_id text NOT NULL,
  subject text NOT NULL,
  ended_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id, subject)
);
CREATE TABLE unassigned_members (
  tenant_id text NOT NULL,
  member_id text NOT NULL,
  username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, member_id)
);
REVOKE ALL ON member_session_ends, unassigned_members FROM PUBLIC;
