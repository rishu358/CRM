-- Platform tables: tenants, identity, auth, RBAC and field metadata.
-- Applied as crm_migrator, which owns everything it creates.
-- Forward-only: never edit this file once merged, add a new migration.

-- ---------------------------------------------------------------------------
-- Tenants. Not tenant-owned: this is the registry of tenants themselves.
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                      uuid PRIMARY KEY,
  name                    text NOT NULL,
  slug                    text NOT NULL,
  plan                    text NOT NULL DEFAULT 'free',
  region                  text NOT NULL DEFAULT 'ap-south-1',
  default_currency        text NOT NULL DEFAULT 'INR',
  timezone                text NOT NULL DEFAULT 'Asia/Kolkata',
  locale                  text NOT NULL DEFAULT 'en-IN',
  fiscal_year_start_month text NOT NULL DEFAULT '4',
  status                  text NOT NULL DEFAULT 'active',
  settings                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT tenants_currency_chk CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT tenants_slug_chk     CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);
CREATE INDEX tenants_status_idx ON tenants (status);

-- ---------------------------------------------------------------------------
-- Global identity. One row per person across every tenant (ADR-0014).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  uuid PRIMARY KEY,
  email               citext NOT NULL,
  email_verified_at   timestamptz,
  name                text NOT NULL,
  image               text,
  locale              text NOT NULL DEFAULT 'en-IN',
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  mfa_enabled         boolean NOT NULL DEFAULT false,
  -- Bumping this invalidates every session issued earlier, so a password
  -- change revokes other devices with one write (MVP_SPEC M1).
  sessions_valid_from timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id    uuid NOT NULL,
  status     text NOT NULL DEFAULT 'invited',
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  invited_at timestamptz,
  joined_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT memberships_status_chk CHECK (status IN ('invited', 'active', 'suspended'))
);
CREATE UNIQUE INDEX memberships_tenant_user_key ON memberships (tenant_id, user_id);
CREATE INDEX memberships_tenant_role_idx ON memberships (tenant_id, role_id);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ---------------------------------------------------------------------------
-- Auth. Global like users: a session belongs to a person, not to a tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token            text NOT NULL,
  expires_at       timestamptz NOT NULL,
  ip_address       text,
  user_agent       text,
  -- Re-checked against memberships on every request; never trusted alone.
  active_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);
CREATE UNIQUE INDEX sessions_token_key ON sessions (token);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE auth_accounts (
  id                        uuid PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id               text NOT NULL,
  account_id                text NOT NULL,
  password_hash             text,
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_accounts_provider_account_key ON auth_accounts (provider_id, account_id);
CREATE INDEX auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE verifications (
  id          uuid PRIMARY KEY,
  identifier  text NOT NULL,
  value       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);
CREATE INDEX verifications_expires_idx ON verifications (expires_at);

CREATE TABLE mfa_factors (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        text NOT NULL,
  secret      text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_factors_type_chk CHECK (type IN ('totp', 'backup_codes'))
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id);

-- Append-only record of authentication attempts. Never stores the credential.
CREATE TABLE auth_events (
  id          uuid PRIMARY KEY,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Recorded even when no user matches, so probing for valid addresses is visible.
  email       text,
  type        text NOT NULL,
  ip_address  text,
  user_agent  text,
  request_id  text,
  succeeded   boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_email_time_idx ON auth_events (email, occurred_at);
CREATE INDEX auth_events_user_time_idx ON auth_events (user_id, occurred_at);

-- ---------------------------------------------------------------------------
-- RBAC. Tenant-owned: a tenant must never see another's permission setup.
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);
CREATE UNIQUE INDEX roles_tenant_name_key ON roles (tenant_id, name);

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles (id);

CREATE TABLE role_permissions (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  object_type text NOT NULL,
  action      text NOT NULL,
  scope       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT role_permissions_action_chk
    CHECK (action IN ('read', 'create', 'update', 'delete', 'export', 'import')),
  CONSTRAINT role_permissions_scope_chk
    CHECK (scope IN ('own', 'team', 'all'))
);
CREATE UNIQUE INDEX role_permissions_unique
  ON role_permissions (tenant_id, role_id, object_type, action);
CREATE INDEX role_permissions_tenant_role_idx ON role_permissions (tenant_id, role_id);

CREATE TABLE field_permissions (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  object_type text NOT NULL,
  field_key   text NOT NULL,
  access      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT field_permissions_access_chk CHECK (access IN ('hidden', 'read', 'write'))
);
CREATE UNIQUE INDEX field_permissions_unique
  ON field_permissions (tenant_id, role_id, object_type, field_key);
CREATE INDEX field_permissions_tenant_role_idx ON field_permissions (tenant_id, role_id);

CREATE TABLE teams (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name           text NOT NULL,
  parent_team_id uuid REFERENCES teams (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid
);
CREATE UNIQUE INDEX teams_tenant_name_key ON teams (tenant_id, name);
CREATE INDEX teams_tenant_parent_idx ON teams (tenant_id, parent_team_id);

CREATE TABLE team_members (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE UNIQUE INDEX team_members_unique ON team_members (tenant_id, team_id, user_id);
CREATE INDEX team_members_tenant_user_idx ON team_members (tenant_id, user_id);

-- ---------------------------------------------------------------------------
-- Field metadata (ADR-0004). System and custom fields live together so that
-- forms, lists, filters, import and export have exactly one source to read.
-- ---------------------------------------------------------------------------
CREATE TABLE field_definitions (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type   text NOT NULL,
  key           text NOT NULL,
  label         text NOT NULL,
  type          text NOT NULL,
  required      boolean NOT NULL DEFAULT false,
  is_unique     boolean NOT NULL DEFAULT false,
  options       jsonb,
  validation    jsonb,
  default_value jsonb,
  position      integer NOT NULL DEFAULT 0,
  is_system     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  -- Keys become jsonb paths and API property names, so they are constrained
  -- here as well as in @crm/core: this is the boundary that cannot be bypassed.
  CONSTRAINT field_definitions_key_chk CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT field_definitions_type_chk CHECK (type IN (
    'text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime',
    'boolean', 'picklist', 'multi_picklist', 'email', 'phone', 'url', 'user_lookup'
  ))
);
CREATE UNIQUE INDEX field_definitions_tenant_object_key
  ON field_definitions (tenant_id, object_type, key);
CREATE INDEX field_definitions_tenant_object_idx
  ON field_definitions (tenant_id, object_type, position);

CREATE TABLE saved_views (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type text NOT NULL,
  name        text NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns     jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort        jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility  text NOT NULL DEFAULT 'private',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT saved_views_visibility_chk CHECK (visibility IN ('private', 'team', 'tenant'))
);
CREATE INDEX saved_views_tenant_object_idx ON saved_views (tenant_id, object_type);
CREATE UNIQUE INDEX saved_views_tenant_object_name_owner_key
  ON saved_views (tenant_id, object_type, name, created_by);
