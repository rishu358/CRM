// Connect the way the API does (node-postgres, the connection string as given) and report two
// things psql cannot tell you: whether TLS verifies against this provider's certificate, and which
// role the string really is. ADR-0042, docs/RUNBOOK.md §9.6.
//
//   DATABASE_URL='postgres://crm_app:...@host:25060/crm?sslmode=require' \
//     pnpm --filter @crm/db exec node ../../deploy/check-app-connection.mjs
//
// Run it from a machine that is allowed to reach the database (the cluster's trusted sources), with
// the `crm_app` URL: it should be exactly the value you gave the API. It prints no URL and no
// password. Exit 0 only if the connection works AND the role cannot bypass row-level security.

import { createRequire } from 'node:module';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('[FAIL] DATABASE_URL is not set');
  process.exit(2);
}

// Resolve `pg` the way packages/db does, whatever directory this is run from.
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pg = require('pg');

const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
let failed = false;
try {
  const { rows } = await pool.query(
    `select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls
       from pg_roles r where r.rolname = current_user`,
  );
  console.log('[PASS] Connected with the connection string exactly as the API would use it.');
  const role = rows[0];
  if (role.superuser || role.bypassrls) {
    failed = true;
    console.log(
      `[FAIL] Role "${role.name}" ${role.superuser ? 'is a superuser' : 'has BYPASSRLS'}. ` +
        'The API and worker will refuse to start with it. Use the crm_app role.',
    );
  } else {
    console.log(`[PASS] Role "${role.name}" is NOSUPERUSER NOBYPASSRLS.`);
  }
} catch (error) {
  failed = true;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const text = error instanceof Error ? error.message : String(error);
  if (
    /SELF_SIGNED|self.signed|UNABLE_TO_VERIFY|unable to verify|certificate/i.test(`${code} ${text}`)
  ) {
    console.log(
      '[FAIL] TLS verification failed: node-postgres treats sslmode=require as verify-full, and ' +
        "this provider's certificate is signed by a private CA that Node does not trust. " +
        'The API will fail the same way. Decide with docs/adr/0042 (Open question 1) and RUNBOOK §9.6; ' +
        `do not "fix" it with sslmode=no-verify without reading why not. (${code || 'no code'})`,
    );
  } else {
    // pg messages can echo the host or user but never the password; still print only the message.
    console.log(`[FAIL] ${code ? `${code}: ` : ''}${text}`);
  }
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(failed ? 1 : 0);
