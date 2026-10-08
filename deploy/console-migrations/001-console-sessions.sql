CREATE TABLE login_flows (
  flow_hash text PRIMARY KEY CHECK (flow_hash ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL CHECK (tenant_id = 'operator'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE INDEX login_flows_expiry ON login_flows(expires_at);

CREATE TABLE sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL CHECK (tenant_id = 'operator'),
  subject text NOT NULL,
  username text NOT NULL,
  roles text[] NOT NULL,
  sid text NOT NULL,
  nonce text NOT NULL,
  csrf_token text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_sid ON sessions(tenant_id, sid);
CREATE INDEX sessions_subject ON sessions(tenant_id, subject);

CREATE TABLE logout_events (
  tenant_id text NOT NULL CHECK (tenant_id = 'operator'),
  jti text NOT NULL,
  sid text NOT NULL,
  subject text,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id, jti)
);
CREATE INDEX logout_events_sid ON logout_events(tenant_id, sid);

ALTER TABLE login_flows ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE member_session_ends (tenant_id text NOT NULL CHECK (tenant_id='operator'), subject text NOT NULL, ended_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,subject));
REVOKE ALL ON login_flows, sessions, logout_events, member_session_ends FROM PUBLIC;
