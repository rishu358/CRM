import { withTenant, withoutTenant, type Database, type Tx, sql } from '@crm/db';
import type { Logger } from 'pino';

/**
 * The outbox relay (ADR-0006).
 *
 * Reads `outbox_events` across every tenant — the one documented exception to
 * tenant scoping, which is why the worker connects as `crm_worker` and why that
 * role's permissive policy covers this table and nothing else. Before touching
 * any tenant data, the relay opens a tenant-scoped transaction for the event's
 * own tenant, so handlers run under exactly the same RLS as the API.
 *
 * Delivery is **at-least-once**. A handler can be invoked twice for the same
 * event — a crash between doing the work and marking the row relayed is normal,
 * not exceptional — so every handler must be idempotent.
 */
export interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly object_type: string | null;
  readonly record_id: string | null;
  readonly payload: Record<string, unknown>;
  readonly actor_id: string | null;
  readonly attempts: number;
}

/** A handler runs inside a transaction already scoped to the event's tenant. */
export type EventHandler = (tx: Tx, event: OutboxRow) => Promise<void>;

export interface RelayOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly logger: Logger;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Claim a batch of due events.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several worker processes drain the same
 * queue without coordinating: each claims rows the others have not locked,
 * rather than all of them blocking on the oldest row.
 */
async function claimBatch(db: Database, batchSize: number): Promise<OutboxRow[]> {
  return withoutTenant(db, async (tx) => {
    const result = await tx.execute(sql`
      with claimed as (
        select id
        from outbox_events
        where status = 'pending'
          and available_at <= now()
        order by available_at
        limit ${batchSize}
        for update skip locked
      )
      update outbox_events o
      set status = 'processing', attempts = o.attempts + 1
      from claimed
      where o.id = claimed.id
      returning o.id, o.tenant_id, o.event_type, o.object_type, o.record_id,
                o.payload, o.actor_id, o.attempts
    `);
    return result.rows as unknown as OutboxRow[];
  });
}

/**
 * Exponential backoff, capped.
 *
 * A failing handler should not spin: by the eighth attempt the delay is minutes,
 * which gives a transient dependency time to recover and keeps a permanently
 * broken event from consuming the batch budget every tick.
 */
function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, 600);
}

export class OutboxRelay {
  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(
    private readonly db: Database,
    private readonly options: RelayOptions,
  ) {}

  /** Subscribe to an event type. Several handlers may share one type. */
  on(eventType: string, handler: EventHandler): this {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
    return this;
  }

  /** Drain one batch. Returns how many events were processed. */
  async tick(): Promise<number> {
    const batch = await claimBatch(this.db, this.options.batchSize ?? DEFAULT_BATCH_SIZE);

    for (const event of batch) {
      await this.process(event);
    }
    return batch.length;
  }

  private async process(event: OutboxRow): Promise<void> {
    const handlers = this.handlers.get(event.event_type) ?? [];

    if (handlers.length === 0) {
      // Nobody is listening yet. Mark it relayed rather than retrying forever:
      // an event with no subscriber is not a failure, and a handler added later
      // picks up new events, not a backlog of ones it never knew about.
      await this.markRelayed(event.id);
      return;
    }

    try {
      // One transaction per event, scoped to its tenant. Handlers therefore run
      // under the same RLS the API does, and a handler that forgets about
      // tenancy sees nothing rather than everything.
      await withTenant(
        this.db,
        { tenantId: event.tenant_id, userId: event.actor_id },
        async (tx) => {
          for (const handler of handlers) {
            await handler(tx, event);
          }
        },
      );
      await this.markRelayed(event.id);
    } catch (error) {
      await this.markFailed(event, error);
    }
  }

  private async markRelayed(id: string): Promise<void> {
    await withoutTenant(this.db, (tx) =>
      tx.execute(
        sql`update outbox_events set status = 'relayed', relayed_at = now(), last_error = null where id = ${id}`,
      ),
    );
  }

  private async markFailed(event: OutboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const exhausted = event.attempts >= maxAttempts;

    this.options.logger.error(
      { eventId: event.id, eventType: event.event_type, attempts: event.attempts, exhausted },
      `Outbox handler failed: ${message}`,
    );

    await withoutTenant(this.db, (tx) =>
      tx.execute(
        exhausted
          ? sql`update outbox_events set status = 'failed', last_error = ${message} where id = ${event.id}`
          : sql`update outbox_events
                set status = 'pending',
                    last_error = ${message},
                    available_at = now() + make_interval(secs => ${backoffSeconds(event.attempts)})
                where id = ${event.id}`,
      ),
    );
  }
}
