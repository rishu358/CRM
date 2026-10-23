import { createDbClient } from './client.js';
import { loadDbEnv } from './env.js';
import { loadRootEnvFile } from './load-env.js';
import { reindexAll } from './search/reindex-all.js';

/** CLI entry point: `pnpm db:reindex [-- --tenant <uuid>]`. See `search/reindex-all.ts`. */

loadRootEnvFile();
const env = loadDbEnv();

const argv = process.argv.slice(2);
const flag = argv.indexOf('--tenant');
const tenantId = flag >= 0 ? argv[flag + 1] : undefined;
if (flag >= 0 && (tenantId === undefined || !/^[0-9a-f-]{36}$/i.test(tenantId))) {
  throw new Error('--tenant needs a company id (a UUID)');
}

const worker = createDbClient({ connectionString: env.DATABASE_WORKER_URL ?? env.DATABASE_URL });
const auth =
  env.DATABASE_AUTH_URL === undefined
    ? null
    : createDbClient({ connectionString: env.DATABASE_AUTH_URL });

try {
  const summary = await reindexAll({ worker, auth }, { tenantId }, (message) => {
    console.warn(message);
  });
  console.warn(
    `Reindexed ${String(summary.tenants)} compan${summary.tenants === 1 ? 'y' : 'ies'}, ` +
      `${String(summary.documents)} documents, ${String(summary.failed.length)} failed.`,
  );
  if (summary.failed.length > 0) process.exitCode = 1;
} finally {
  await worker.close();
  if (auth !== null) await auth.close();
}
