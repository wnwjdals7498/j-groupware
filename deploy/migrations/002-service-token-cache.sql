ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_hash UNIQUE (tenant_id, session_hash);
CREATE TABLE service_tokens (
  tenant_id text NOT NULL,
  session_hash text NOT NULL,
  service_id text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  access_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_hash, service_id),
  FOREIGN KEY (tenant_id, session_hash) REFERENCES sessions(tenant_id, session_hash) ON DELETE CASCADE
);
REVOKE ALL ON service_tokens FROM PUBLIC;
