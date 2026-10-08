CREATE TABLE customers (
 tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z][a-z0-9-]{2,30}$' AND tenant_id <> 'operator'),
 registration text NOT NULL CHECK (registration IN ('creating','ready','auth_uncertain','bootstrap_unrecoverable')),
 agent_key_hash text UNIQUE CHECK (agent_key_hash IS NULL OR agent_key_hash ~ '^[a-f0-9]{64}$'),
 agent_epoch integer NOT NULL DEFAULT 1 CHECK (agent_epoch>0),
 desired_services text[] NOT NULL DEFAULT '{}',
 desired_revision integer NOT NULL DEFAULT 1 CHECK (desired_revision>0),
 auth_services text[] NOT NULL DEFAULT '{}',
 auth_state text NOT NULL DEFAULT 'unknown' CHECK (auth_state IN ('unknown','pending','applied','failed')),
 auth_checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_reports (
 tenant_id text PRIMARY KEY REFERENCES customers(tenant_id),
 desired_revision integer NOT NULL CHECK (desired_revision>0),
 agent_epoch integer NOT NULL CHECK (agent_epoch>0),
 report_sequence integer NOT NULL CHECK (report_sequence>0),
 report jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON customers,agent_reports FROM PUBLIC;
