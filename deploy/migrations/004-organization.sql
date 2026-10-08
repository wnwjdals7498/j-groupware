CREATE TABLE organization_state (
  tenant_id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE organization_departments (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  parent_id uuid,
  head_member_id text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES organization_departments(tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX organization_root_names ON organization_departments(tenant_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX organization_sibling_names ON organization_departments(tenant_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE TABLE organization_positions (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);
-- Preserve registrations from 003, initially with no department or position.
ALTER TABLE unassigned_members RENAME TO organization_members;
ALTER TABLE organization_members ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE organization_members ADD COLUMN department_id uuid;
ALTER TABLE organization_members ADD COLUMN position_id uuid;
ALTER TABLE organization_members ADD FOREIGN KEY (tenant_id, department_id) REFERENCES organization_departments(tenant_id, id);
ALTER TABLE organization_members ADD FOREIGN KEY (tenant_id, position_id) REFERENCES organization_positions(tenant_id, id);
ALTER TABLE organization_departments ADD FOREIGN KEY (tenant_id, head_member_id) REFERENCES organization_members(tenant_id, member_id);
CREATE INDEX organization_member_order ON organization_members(tenant_id, username COLLATE "C", member_id COLLATE "C");
CREATE INDEX organization_member_department ON organization_members(tenant_id, department_id);
CREATE INDEX organization_member_position ON organization_members(tenant_id, position_id);
REVOKE ALL ON organization_state, organization_departments, organization_positions, organization_members FROM PUBLIC;
