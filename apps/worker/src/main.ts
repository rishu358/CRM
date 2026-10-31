import { assertConnectedRoles } from '@crm/core';
import { createDbClient, PostgresSearchProvider, readPoolRole, withTenant } from '@crm/db';
import { createStorageProvider } from '@crm/storage';
import { pino } from 'pino';
import { loadWorkerEnv, productionWarnings } from './env.js';
import { createEmailProvider } from './email/provider.js';
import { pruneActivityLinks } from './handlers/activities.js';
import { pruneAttachments, purgeAttachment, verifyAttachment } from './handlers/attachments.js';

import { rearmSweepOnExhaustion, runPurgeSweep } from './handlers/recycle-bin.js';
import { failDataExportOnExhaustion, runDataExport } from './data-rights/archive-handler.js';
import {
  failErasureOnExhaustion,
  runErasure,
  runErasureRedaction,
} from './data-rights/erasure-handler.js';
import {
  notifyAssignment,
  notifyReminder,
  notifyWebFormDuplicate,
  notifyWebFormLead,
  sendDigest,
} from './handlers/notifications.js';
import { indexSearchDocument, removeSearchDocument } from './handlers/search.js';
import { removeSampleDataJob } from './handlers/sample-data.js';
import { failEmailOnExhaustion, sendQueuedEmail, watchEmail } from './handlers/email.js';
import { applyEmailProviderEvent } from './handlers/email-events.js';
import { linkLeadEmailsOnConversion } from './handlers/email-links.js';
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
for (const warning of productionWarnings(env)) logger.warn(warning);

const client = createDbClient({
  connectionString: env.DATABASE_WORKER_URL ?? env.DATABASE_URL,
  caCert: env.DATABASE_CA_CERT,
  maxConnections: env.DATABASE_POOL_MAX,
});

const relay = new OutboxRelay(client.db, {
  batchSize: env.OUTBOX_BATCH_SIZE,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  logger,
});

// The timeline and the search index keep a record's own bookkeeping true, so they see imported
// history too; everything else is quiet for it by default (ADR-0071).
relay.onHistory('contact.created.v1', projectTimeline);
relay.onHistory('contact.updated.v1', projectTimeline);
relay.on('contact.deleted.v1', projectTimeline);
relay.onHistory('deal.created.v1', projectTimeline);
relay.onHistory('deal.updated.v1', projectTimeline);
relay.on('deal.deleted.v1', projectTimeline);
relay.on('deal.stage_changed.v1', projectTimeline);
relay.onHistory('lead.created.v1', projectTimeline);
relay.onHistory('lead.updated.v1', projectTimeline);
relay.on('lead.deleted.v1', projectTimeline);
relay.on('lead.web_form_duplicate.v1', projectTimeline);
relay.on('lead.converted.v1', projectTimeline);
relay.on('contact.linked_from_lead.v1', projectTimeline);
relay.on('account.linked_from_lead.v1', projectTimeline);
relay.on('activity.linked.v1', projectTimeline);
relay.on('activity.completed.v1', projectTimeline);
for (const objectType of ['account', 'contact', 'lead', 'deal', 'activity'] as const) {
  relay.on(`${objectType}.restored.v1`, projectTimeline);
}
relay.on('email.sent.v1', projectTimeline);
relay.on('email.failed.v1', projectTimeline);
relay.on('email.delivered.v1', projectTimeline);
relay.on('email.bounced.v1', projectTimeline);
relay.on('email.complained.v1', projectTimeline);
relay.on('contact.merged.v1', projectTimeline);
relay.on('account.merged.v1', projectTimeline);

/**
 * Notifications and the digest (MVP_SPEC M6, ADR-0025).
 *
 * The reminder handler is subscribed to an event the API dated to the
 * future; the relay will not pick it up until then, which is the whole
 * scheduler.
 */
const notificationOptions = {
  email: createEmailProvider({
    kind: env.EMAIL_PROVIDER,
    nodeEnv: env.NODE_ENV,
    logger,
    resendApiKey: env.RESEND_API_KEY,
    sesRegion: env.SES_REGION,
    sesAccessKeyId: env.SES_ACCESS_KEY_ID,
    sesSecretAccessKey: env.SES_SECRET_ACCESS_KEY,
    sesConfigurationSet: env.SES_CONFIGURATION_SET,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecurity: env.SMTP_SECURITY,
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    from: env.EMAIL_FROM,
  }),
  emailFrom: env.EMAIL_FROM,
  webUrl: env.WEB_URL,
  appName: env.APP_NAME,
  digestWindowMinutes: env.DIGEST_WINDOW_MINUTES,
};

/**
 * Email sent from a record (ADR-0073).
 *
 * A second provider instance of the same adapter, built with the outreach address, so a customer's
 * email is sent as `EMAIL_OUTREACH_FROM` and a spam complaint about it cannot touch the reputation of
 * sign-in mail. It sends in no transaction and at most once; the watchdog is what notices a message
 * a crashed worker left behind.
 */
const emailDeps = {
  db: client.db,
  logger,
  email: createEmailProvider({
    kind: env.EMAIL_PROVIDER,
    nodeEnv: env.NODE_ENV,
    logger,
    resendApiKey: env.RESEND_API_KEY,
    sesRegion: env.SES_REGION,
    sesAccessKeyId: env.SES_ACCESS_KEY_ID,
    sesSecretAccessKey: env.SES_SECRET_ACCESS_KEY,
    sesConfigurationSet: env.SES_CONFIGURATION_SET,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecurity: env.SMTP_SECURITY,
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    from: env.EMAIL_OUTREACH_FROM ?? env.EMAIL_FROM,
  }),
};
relay.on('email.queued.v1', sendQueuedEmail(emailDeps));
relay.on('email.watchdog_due.v1', watchEmail(emailDeps));
relay.onExhausted('email.queued.v1', failEmailOnExhaustion(emailDeps));
// What the mail service reported about an email, applied inside the company it belongs to (ADR-0075).
relay.on('email.provider_event.v1', applyEmailProviderEvent());
// A converted lead's emails also show on the contact and deal it became (ADR-0074).
relay.on('lead.converted.v1', linkLeadEmailsOnConversion());

relay.on('activity.assigned.v1', notifyAssignment(notificationOptions));
relay.on('activity.reminder_due.v1', notifyReminder());
relay.on('lead.created.v1', notifyWebFormLead(notificationOptions));
relay.on('lead.web_form_duplicate.v1', notifyWebFormDuplicate(notificationOptions));
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
  relay.onHistory(`${objectType}.created.v1`, indexSearchDocument(search));
  relay.onHistory(`${objectType}.updated.v1`, indexSearchDocument(search));
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
  // The same seam a list's search box uses (ADR-0041 §5); the one line that changes with the engine.
  search: new PostgresSearchProvider(),
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
 * Record attachments (MVP_SPEC §6.1, ADR-0035).
 *
 * The byte check is here for the same reason an import's is: the API signs
 * URLs and reads metadata, and the worker is the only process that ever reads
 * a file's bytes (CLAUDE.md §5.12). The purge is driven by an event the delete
 * dated to the end of the retention window, so the outbox is the scheduler
 * (ADR-0025) and there is no sweep.
 */
const attachmentDeps = { storage: importExportDeps.storage, logger };

relay.on('attachment.uploaded.v1', verifyAttachment(attachmentDeps));
relay.on('attachment.purge_due.v1', purgeAttachment(attachmentDeps));

/**
 * Orphan cleanup for polymorphic links (ADR-0005).
 *
 * The delete events of every linkable object, because neither the link table
 * nor the attachments table has a foreign key to tell it when a target
 * disappears. An orphaned attachment is worse than an orphaned link row — a
 * private file nobody can reach and everybody pays to store — so its handler
 * removes the stored object as well.
 */
relay.on('contact.deleted.v1', pruneActivityLinks);
relay.on('account.deleted.v1', pruneActivityLinks);
relay.on('lead.deleted.v1', pruneActivityLinks);
relay.on('deal.deleted.v1', pruneActivityLinks);

for (const objectType of ['account', 'contact', 'lead', 'deal', 'activity'] as const) {
  relay.on(`${objectType}.deleted.v1`, pruneAttachments(attachmentDeps));
  // The Recycle Bin's retention sweep hard-deletes a record and publishes
  // `<object>.purged.v1` (ADR-0034). A soft delete keeps a record's files so
  // restoring it brings them back, which is why files are only removed here,
  // once the row is really gone — ADR-0035 and ADR-0034 §7 each said this
  // subscriber would be needed once both features existed. `pruneAttachments`
  // already checks that the row has gone, so it is idempotent under redelivery.
  relay.on(`${objectType}.purged.v1`, pruneAttachments(attachmentDeps));
}

/**
 * The Recycle Bin and data rights (MVP_SPEC M4, M11).
 *
 * The purge sweep is scheduled by the outbox and re-arms itself, so these three
 * lines are the entire schedule: no cron, no cross-tenant scan (ADR-0025,
 * ADR-0034). An erasure is two events on purpose — see `erasure-handler.ts` for
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

// Company setup (MVP_SPEC M2): removing sample data clears search and timeline
// rows the application role cannot write, so it is the worker's to do (ADR-0037).
relay.on('sample_data.removal_requested.v1', removeSampleDataJob({ logger }));
relay.onExhausted('data_export.requested.v1', failDataExportOnExhaustion(archiveDeps));

const erasureClient =
  env.DATABASE_ERASURE_URL === undefined
    ? null
    : createDbClient({
        connectionString: env.DATABASE_ERASURE_URL,
        caCert: env.DATABASE_CA_CERT,
        maxConnections: 2,
      });

const erasureDeps = { db: client.db, erasureDb: erasureClient?.db ?? null, logger };
relay.on('erasure.requested.v1', runErasure(erasureDeps));
relay.on('erasure.claimed.v1', runErasureRedaction(erasureDeps));
relay.onExhausted('erasure.requested.v1', failErasureOnExhaustion(erasureDeps));
relay.onExhausted('erasure.claimed.v1', failErasureOnExhaustion(erasureDeps));

// In production, refuse to run as a role that can bypass row-level security (CLAUDE.md §5.1): the
// administrative role of a managed database does, and the worker holds the widest reads we grant.
// Development and tests run as the roles the bootstrap built and are not asked.
if (env.NODE_ENV === 'production') {
  try {
    assertConnectedRoles({
      [env.DATABASE_WORKER_URL === undefined ? 'DATABASE_URL' : 'DATABASE_WORKER_URL']:
        await readPoolRole(client.pool),
      ...(erasureClient === null
        ? {}
        : { DATABASE_ERASURE_URL: await readPoolRole(erasureClient.pool) }),
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Worker refused to start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(1);
  }
}

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
