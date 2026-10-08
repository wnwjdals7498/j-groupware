CREATE TABLE login_flows (
  flow_hash text PRIMARY KEY CHECK (flow_hash ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL,
  state_hash text NOT NULL CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE INDEX login_flows_expiry ON login_flows(expires_at);

CREATE TABLE sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL,
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
  tenant_id text NOT NULL,
  jti text NOT NULL,
  sid text NOT NULL,
  subject text,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id, jti)
);
CREATE INDEX logout_events_sid ON logout_events(tenant_id, sid);

CREATE TABLE board_posts (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  author_id text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX board_posts_listing ON board_posts(tenant_id, created_at DESC, id DESC);
REVOKE ALL ON login_flows, sessions, logout_events, board_posts FROM PUBLIC;
