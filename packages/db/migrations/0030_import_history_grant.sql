-- F7-3 (ADR-0069): the right to import original dates.
--
-- `import_history` is a new administrative object type (like `pipeline` in 0024): `create` means a
-- file may carry the date each record was really created. Owner and Admin get it for every tenant
-- that already exists; a custom role gets nothing, which is the right default-deny answer. New
-- tenants get the same rows from the seed (`packages/db/src/seed/roles.ts`).
CREATE POLICY role_permissions_f7_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_f7_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'import_history', 'create', 'all', now(), now()
FROM roles r
WHERE r.is_system AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY role_permissions_f7_backfill ON role_permissions;
DROP POLICY roles_f7_backfill ON roles;
