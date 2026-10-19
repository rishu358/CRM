import { createDbClient, PostgresSearchProvider, withTenant } from '@crm/db';
import { createStorageProvider } from '@crm/storage';
import { pino } from 'pino';
import { loadWorkerEnv } from './env.js';
import { createEmailProvider } from './email/provider.js';
import { pruneActivityLinks } from './handlers/activities.js';
import { rearmSweepOnExhaustion, runPurgeSweep } from './handlers/recycle-bin.js';
import {
  failDataExportOnExhaustion,
  runDataExport,
} from './data-rights/archive-handler.js';
import {
  failErasureOnExhaustion,
  runErasure,
  runErasureRedaction,
} from './data-rights/erasure-handler.js';
import { notifyAssignment, notifyReminder, sendDigest } from './handlers/notifications.js';
import { indexSearchDocument, removeSearchDocument } from './handlers/search.js';
import { projectTimeline } from './handlers/timeline.js';
import { failExportOnExhaustion, runExport } from './import-export/export-handler.js';
import {
  analyzeImport,
  failImportOnExhaustion,
  processImportChunk,
  stageImport,
} from './import-export/import-handlers.js';
import { DEFAULT_MAX_ATTEMPTS, OutboxRelay } from './relay.js';

/**
 * Worker entry point.
 *
 * Polls rather than listens, deliberately: polling with SKIP LOCKED survives a
 * lost connection, a restart and a backlog without any extra machinery, and the
 * cost of an empty poll on an indexed partial index is negligible. LISTEN/NOTIFY
 * can be added later as a latency optimisation on top, not as the mechanism.
 */
const env = loadWorkerEnv();
const logger = pino({ level: env.LOG_LEVEL });

const client = createDbClient({
  connectionString: env.DATABASE_WORKER_URL ?? env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
});

const relay = new OutboxRelay(client.db, {
  batchSize: env.OUTBOX_BATCH_SIZE,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  logger,
});

relay.on('contact.created.v1', projectTimeline);
relay.on('contact.updated.v1', projectTimeline);
relay.on('contact.deleted.v1', projectTimeline);
relay.on('deal.created.v1', projectTimeline);
relay.on('deal.updated.v1', projectTimeline);
relay.on('deal.deleted.v1', projectTimeline);
relay.on('deal.stage_changed.v1', projectTimeline);
relay.on('lead.created.v1', projectTimeline);
relay.on('lead.updated.v1', projectTimeline);
relay.on('lead.deleted.v1', projectTimeline);
relay.on('lead.converted.v1', projectTimeline);
relay.on('contact.linked_from_lead.v1', projectTimeline);
relay.on('account.linked_from_lead.v1', projectTimeline);
relay.on('activity.linked.v1', projectTimeline);
relay.on('activity.completed.v1', projectTimeline);
for (const objectType of ['account', 'contact', 'lead', 'deal', 'activity'] as const) {
  relay.on(`${objectType}.restored.v1`, projectTimeline);
}

/**
 * Notifications and the digest (MVP_SPEC M6, ADR-0025).
 *
 * The reminder handler is subscribed to an event the API dated to the
 * future; the relay will not pick it up until then, which is the whole
 * scheduler.
 */
const notificationOptions = {
  email: createEmailProvider(env.EMAIL_PROVIDER, env.NODE_ENV, logger),
  emailFrom: env.EMAIL_FROM,
  webUrl: env.WEB_URL,
  digestWindowMinutes: env.DIGEST_WINDOW_MINUTES,
};

relay.on('activity.assigned.v1', notifyAssignment(notificationOptions));
relay.on('activity.reminder_due.v1', notifyReminder());
relay.on('notification.digest_due.v1', sendDigest(notificationOptions));

/**
 * The search index (MVP_SPEC M7, ADR-0028).
 *
 * Every create and update of a searchable record re-projects it; every delete
 * removes it. Driven by events rather than called inline, so a record is
 * findable — or stops being findable — without any service remembering to say
 * so. The index handler also removes a record whose row has gone by the time
 * the event is relayed, so a delete cannot be lost by arriving out of order.
 *
 * One line decides the engine (CLAUDE.md §2, ADR-0009).
 */
const search = new PostgresSearchProvider();

for (const objectType of ['account', 'contact', 'lead', 'deal', 'activity'] as const) {
  relay.on(`${objectType}.created.v1`, indexSearchDocument(search));
  relay.on(`${objectType}.updated.v1`, indexSearchDocument(search));
  // A restore is an un-delete, so it re-projects exactly as an update does
  // (MVP_SPEC M4). The index handler reads the record, so a record restored and
  // re-deleted before the relay caught up still ends in the right state.
  relay.on(`${objectType}.restored.v1`, indexSearchDocument(search));
  relay.on(`${objectType}.deleted.v1`, removeSearchDocument(search));
  // A purge removes the row itself. The index row is already gone from the soft
  // delete; this is the belt to that braces.
  relay.on(`${objectType}.purged.v1`, removeSearchDocument(search));
}

/**
 * Import and export (MVP_SPEC M8, ADR-0029).
 *
 * The worker is the only process that reads the bytes of an uploaded file or
 * writes a generated one (CLAUDE.md §5.12): the API only signs URLs. An import
 * is a chain of events — uploaded, started, then one `import.chunk.v1` per 500
 * rows, each queuing the next in the same transaction — so progress survives a
 * crash and a redelivery is a no-op.
 */
const importExportDeps = {
  db: client.db,
  storage: createStorageProvider(env, env.NODE_ENV),
  logger,
};

relay.on('import.uploaded.v1', analyzeImport(importExportDeps));
relay.on('import.started.v1', stageImport(importExportDeps));
relay.on('import.chunk.v1', processImportChunk(importExportDeps));
relay.on('export.requested.v1', runExport(importExportDeps));

// When the relay gives up on a step, the job must say so rather than stay
// "in progress" forever (ADR-0029).
for (const eventType of ['import.uploaded.v1', 'import.started.v1', 'import.chunk.v1']) {
  relay.onExhausted(eventType, failImportOnExhaustion(importExportDeps));
}
relay.onExhausted('export.requested.v1', failExportOnExhaustion(importExportDeps));

/**
 * Orphan cleanup for polymorphic links (ADR-0005).
 *
 * The delete events of every linkable object, because the link table has no
 * foreign key to tell it when a target disappears.
 */
relay.on('contact.deleted.v1', pruneActivityLinks);
relay.on('account.deleted.v1', pruneActivityLinks);
relay.on('lead.deleted.v1', pruneActivityLinks);
relay.on('deal.deleted.v1', pruneActivityLinks);

/**
 * The Recycle Bin and data rights (MVP_SPEC M4, M11).
 *
 * The purge sweep is scheduled by the outbox and re-arms itself, so these three
 * lines are the entire schedule: no cron, no cross-tenant scan (ADR-0025,
 * ADR-0031). An erasure is two events on purpose — see `erasure-handler.ts` for
 * why the redaction window has to be committed before it can be used
 * (ADR-0032).
 */
relay.on('recycle_bin.sweep_due.v1', runPurgeSweep());
relay.onExhausted(
  'recycle_bin.sweep_due.v1',
  rearmSweepOnExhaustion({
    withTenant: (tenantId, work) => withTenant(client.db, { tenantId, userId: null }, work),
  }),
);

const archiveDeps = {
  db: client.db,
  storage: importExportDeps.storage,
  logger,
};
relay.on('data_export.requested.v1', runDataExport(archiveDeps));
relay.onExhausted('data_export.requested.v1', failDataExportOnExhaustion(archiveDeps));

const erasureClient =
  env.DATABASE_ERASURE_URL === undefined
    ? null
    : createDbClient({ connectionString: env.DATABASE_ERASURE_URL, maxConnections: 2 });

const erasureDeps = { db: client.db, erasureDb: erasureClient?.db ?? null, logger };
relay.on('erasure.requested.v1', runErasure(erasureDeps));
relay.on('erasure.claimed.v1', runErasureRedaction(erasureDeps));
relay.onExhausted('erasure.requested.v1', failErasureOnExhaustion(erasureDeps));
relay.onExhausted('erasure.claimed.v1', failErasureOnExhaustion(erasureDeps));

let running = true;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutting down');
  running = false;
  await client.close();
  await erasureClient?.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ interval: env.OUTBOX_POLL_INTERVAL_MS }, 'Outbox relay started');

while (running) {
  try {
    const processed = await relay.tick();
    // Only sleep when the queue was empty. A full batch means there is more
    // waiting, and pausing would let a backlog grow faster than it drains.
    if (processed === 0) {
      await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
    }
  } catch (error) {
    logger.error({ err: error }, 'Relay tick failed');
    await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
  }
}
