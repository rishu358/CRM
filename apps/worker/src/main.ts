import { createDbClient } from '@crm/db';
import { pino } from 'pino';
import { loadWorkerEnv } from './env.js';
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
