-- Team invitations (MVP_SPEC M2, ADR-0018).
--
-- Forward-only and safe on a live database: one new table, one new CHECK on an
-- empty column set, and an INSERT that backfills grants for roles that already
-- exist. Nothing rewrites an existing row and nothing holds a long lock
-- (CLAUDE.md §7).

-- ---------------------------------------------------------------------------
-- invitations
--
-- Tenant-owned, because an invitation *is* tenant data: it names a workspace,
-- carries the role it confers, and must be listable and revocable by that
-- workspace's administrators and by nobody else.
--
-- The token digest lives here rather than in `verifications` for that same
-- reason. `verifications` is global and reachable only by crm_auth, with
-- nowhere to put a tenant or a role; splitting one invitation across both
-- tables would mean two rows that can disagree about when it expires and
-- whether it has been used. What is reused is the mechanism, which is the part
-- that matters: only the SHA-256 of the token is stored, and redemption is a
-- single UPDATE with `accepted_at IS NULL` in its WHERE, so two concurrent
-- redemptions cannot both win (ADR-0018).
--
-- `created_by` is the inviter and `created_at` the invitation time;
-- `memberships.invited_by` and `invited_at` are filled from them on
-- acceptance. Note there is deliberately **no membership row while an
-- invitation is pending**: one could only be written for an address that
-- already has a user, so its presence would tell an administrator which of the
-- addresses they invited already have accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  token_hash      text NOT NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,

  CONSTRAINT invitations_revoked_reason_chk
    CHECK (revoked_reason IS NULL OR revoked_reason IN ('revoked', 'superseded')),
  -- An invitation cannot be both accepted and revoked. Without this, a race
  -- between "accept" and "revoke" could leave a row that reads as either
  -- depending on which column you look at.
  CONSTRAINT invitations_outcome_chk
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

-- Lookup is by digest alone, and a collision would be a confused-deputy bug.
CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);

-- Issuing an invitation retires any outstanding one for the same address in
-- the same workspace, which reads by (tenant_id, email).
CREATE INDEX invitations_tenant_email_idx ON invitations (tenant_id, email);

-- The admin list is newest-first within a workspace.
CREATE INDEX invitations_tenant_created_idx ON invitations (tenant_id, created_at);

COMMENT ON COLUMN invitations.token_hash IS
  'SHA-256 of the whole token, prefix included. The token itself is never stored.';
COMMENT ON COLUMN invitations.role_id IS
  'The role this invitation confers. Read from this row at acceptance, never from the request.';

-- Same isolation rules as every other tenant table, applied by the procedure
-- from 0004 so this one cannot receive a weaker variant.
CALL apply_tenant_rls('invitations');

-- No DELETE: an invitation is revoked, never erased, so "who invited whom and
-- what happened" survives. crm_auth gets nothing here — it has no tenant
-- context to be scoped by, and the whole flow runs as crm_app inside the
-- workspace the token names.
GRANT SELECT, INSERT, UPDATE ON invitations TO crm_app;

-- ---------------------------------------------------------------------------
-- Permission to invite
--
-- Inviting is authorized through `can()` like everything else (CLAUDE.md
-- §5.3), which needs a grant to read. `invitation` is an administrative object
-- type: it has no owner, so the only scope that means anything on it is `all`,
-- and only Owner and Admin receive it (MVP_SPEC §4 — they are the personas who
-- "invite the team" and "manage users").
--
-- `provisionTenantDefaults` seeds these for new tenants. This backfills the
-- ones that already exist, matching on the seeded role names, so an existing
-- workspace's Owner is not locked out of a feature their role is meant to
-- include. Scoped to system roles only: a custom role an administrator made
-- and named "Admin" is theirs to grant, not ours.
--
-- The two transient policies below exist because `roles` and
-- `role_permissions` both FORCE row-level security, and crm_migrator — which
-- owns them — therefore matches no policy and would read zero rows and insert
-- nothing, silently. Granting the migrator a cross-tenant view for the length
-- of one statement is the honest way to do a backfill that is, by its nature,
-- cross-tenant. They are dropped immediately, and the whole migration is one
-- transaction, so a failure anywhere leaves neither policy behind.
--
-- gen_random_uuid() rather than a UUIDv7 (ADR-0003): these ids are never
-- exposed in an API, never sorted on and never paged through, and Postgres 16
-- has no v7 generator. The application still mints v7 for every row it writes.
-- ---------------------------------------------------------------------------
CREATE POLICY roles_migrator_backfill ON roles FOR SELECT TO crm_migrator USING (true);
CREATE POLICY role_permissions_migrator_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope)
SELECT
  gen_random_uuid(), r.tenant_id, r.id, 'invitation', a.action, 'all'
FROM roles r
CROSS JOIN (VALUES ('read'), ('create'), ('delete')) AS a (action)
WHERE r.is_system = true
  AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY roles_migrator_backfill ON roles;
DROP POLICY role_permissions_migrator_backfill ON role_permissions;
