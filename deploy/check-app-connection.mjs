// Connect the way the API does (node-postgres, through the same helper `createDbClient` uses) and
// report what psql cannot tell you: whether TLS verifies against this provider's certificate, and
// which role the connection string really is. ADR-0042, docs/RUNBOOK.md §9.6.
//
//   pnpm --filter @crm/db build
//   DATABASE_URL='postgres://crm_app:...@host:25060/crm' DATABASE_CA_CERT="$(base64 -w0 ca.crt)" \
//     node deploy/check-app-connection.mjs
//
// Run it from a machine on the cluster's trusted sources, with the `crm_app` URL and the CA value you
// gave the API: it should be exactly what the API will run with. It prints no URL, no password and no
// certificate. Exit 0 only if the connection verifies AND the role cannot bypass row-level security.

import { createRequire } from 'node:module';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('[FAIL] DATABASE_URL is not set');
  process.exit(2);
}

// `pg` and the helper are resolved from packages/db, whatever directory this is run from.
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pg = require('pg');
let poolConnectionConfig;
try {
  ({ poolConnectionConfig } = await import(new URL('../packages/db/dist/tls.js', import.meta.url)));
} catch {
  console.error('[FAIL] packages/db is not built: run `pnpm --filter @crm/db build` first');
  process.exit(2);
}

const caCert = process.env.DATABASE_CA_CERT;
let config;
try {
  config = poolConnectionConfig(url, caCert);
} catch (error) {
  console.log(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(
  config.ssl === undefined
    ? '[INFO] No DATABASE_CA_CERT: the URL decides TLS, and node-postgres reads sslmode=require as verify-full.'
    : '[INFO] DATABASE_CA_CERT is set: verifying the server against it, hostname included.',
);

const pool = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 10_000 });
let failed = false;
try {
  const { rows } = await pool.query(
    `select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
            coalesce((select s.ssl from pg_stat_ssl s where s.pid = pg_backend_pid()), false) as ssl
       from pg_roles r where r.rolname = current_user`,
  );
  const role = rows[0];
  console.log('[PASS] Connected with the configuration the API would use.');
  if (role.ssl) {
    console.log('[PASS] The session is encrypted.');
  } else {
    failed = true;
    console.log(
      '[FAIL] The session is NOT encrypted. Personal data would cross the network in clear.',
    );
  }
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
  if (/ALTNAME_INVALID/.test(code)) {
    console.log(
      '[FAIL] The certificate does not name the host in DATABASE_URL. Use the exact hostname the provider ' +
        `shows (not an IP address or a private alias the certificate does not list). (${code})`,
    );
  } else if (/SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(`${code} ${text}`)) {
    console.log(
      config.ssl === undefined
        ? "[FAIL] TLS verification failed: the provider's certificate is signed by a private CA that Node does not " +
            "trust. Set DATABASE_CA_CERT to the provider's CA certificate (base64 of the PEM). Do not use " +
            `sslmode=no-verify. (${code || 'no code'})`
        : "[FAIL] TLS verification failed with the CA you set: it is not the CA that signed this server's " +
            `certificate. Download the CA from this cluster's page in the console. (${code || 'no code'})`,
    );
  } else {
    // pg messages can name the host or user but never the password; print only the message.
    console.log(`[FAIL] ${code ? `${code}: ` : ''}${text}`);
  }
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(failed ? 1 : 0);
