/**
 * Reuses the database package's container bootstrap, so the API suite runs
 * against a database built exactly like the one the RLS tests use: roles
 * created by a superuser, schema by crm_migrator, and the application
 * connecting as the unprivileged roles (CLAUDE.md §10).
 */
export { default } from '@crm/db/testing/global-setup';
