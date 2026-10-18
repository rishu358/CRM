import { createDbClient, PostgresSearchProvider } from '@crm/db';
import { pino } from 'pino';
import { loadWorkerEnv } from './env.js';
import { createEmailProvider } from './email/provider.js';
import { pruneActivityLinks } from './handlers/activities.js';
import { notifyAssignment, notifyReminder, sendDigest } from './handlers/notifications.js';
import { indexSearchDocument, removeSearchDocument } from './handlers/search.js';
import { projectTimeline } from './handlers/timeline.js';
import { OutboxRelay } from './relay.js';

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
  relay.on(`${objectType}.deleted.v1`, removeSearchDocument(search));
}

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

let running = true;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutting down');
  running = false;
  await client.close();
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
