-- ---------------------------------------------------------------------------
-- 0013: users, roles and field-permissions administration (MVP_SPEC M3)
--
-- No new tables. Everything the administration screens edit already exists —
-- roles, role_permissions, field_permissions, teams, team_members and
-- memberships — and already has RLS (0004). What did not exist is any grant
-- that lets a person *use* them, because until now nothing in the product
-- edited them.
--
-- Three new object types enter the permission model: `role`, `team` and
-- `membership` (see `OBJECT_TYPES` in @crm/core). They carry no owner, so `all`
-- is the only scope that means anything on them, and a role with no row for
-- them is denied by default like every other denial in this engine.
--
-- `role:read` is also the gate on the access explainer (ADR-0033): it answers
-- questions about the permission configuration, so exactly the people who may
-- read that configuration may ask it questions.
--
-- Tenants provisioned from now on get these from `provisionTenantDefaults`.
-- Everyone already on the platform needs them backfilled, or the screens this
-- migration exists for would be unreachable by their own administrators.
--
-- Only the **system** Owner and Admin roles are touched, and only by name,
-- because those are the two personas MVP_SPEC §4 gives control of "who sees
-- what". A custom role an administrator made earlier gets nothing, which is the
-- right default-deny answer; so does any role that has been renamed away.
--
-- The temporary migrator policies are the pattern 0007 and 0010 established:
-- every tenant table has FORCE ROW LEVEL SECURITY, which applies to the owner
-- too, so a backfill must be allowed explicitly and disallowed again, in this
-- same transaction.
--
-- gen_random_uuid() rather than a UUIDv7 (ADR-0003): these ids are never
-- exposed in an API, never sorted on and never paged through. The application
-- still mints v7 for every row it writes.
-- ---------------------------------------------------------------------------
CREATE POLICY roles_access_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);
CREATE POLICY role_permissions_access_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, g.object_type, g.action, 'all', now(), now()
FROM roles r
CROSS JOIN (
  VALUES
    ('role', 'read'), ('role', 'create'), ('role', 'update'), ('role', 'delete'),
    ('team', 'read'), ('team', 'create'), ('team', 'update'), ('team', 'delete'),
    ('membership', 'read'), ('membership', 'update')
) AS g(object_type, action)
WHERE r.is_system AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY roles_access_backfill ON roles;
DROP POLICY role_permissions_access_backfill ON role_permissions;

-- ---------------------------------------------------------------------------
-- Reassignment reads "who owns these records" per object, always scoped by
-- (tenant_id, owner). 0002/0008/0009 indexed owner_id for the four standard
-- objects and 0010 indexed assigned_to for activities, so no new index is
-- needed; this comment is here so that the next person asking does not add one.
-- ---------------------------------------------------------------------------
