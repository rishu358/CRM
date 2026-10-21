import { can } from '@crm/core';
import { loadActor, removeSampleData, type Tx } from '@crm/db';
import type { Logger } from 'pino';
import type { EventHandler, OutboxRow } from '../relay.js';

/**
 * Removing a company's sample data (MVP_SPEC M2, ADR-0037).
 *
 * The request that asked for this only recorded that it was asked: the cleanup
 * deletes from the search and timeline projections as well as from the records,
 * and the application's database role is deliberately unable to write those. The
 * decision about *what* to remove, and the deletion, are in `removeSampleData`
 * in `@crm/db`, shared with nothing else but written beside the Recycle Bin's
 * purge because it reuses that purge's cleanup.
 *
 * ## Permission is checked again here
 *
 * Between the click and this job running, the person's role may have changed. A
 * handler that trusted the request would let somebody whose rights had been
 * withdrawn finish a deletion, so the requester is loaded afresh and must still
 * hold `tenant_settings:update`. If not, nothing is deleted and the event is
 * simply consumed: the screen goes back to showing the sample data, which is
 * the truth. (The import and archive handlers do the same.)
 *
 * ## At-least-once
 *
 * Delivery can repeat, so this must be safe to run twice. It is: a second run
 * finds an empty registry and returns without touching anything.
 */
export interface SampleDataDeps {
  readonly logger: Logger;
}

export function removeSampleDataJob(deps: SampleDataDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.actor_id === null) {
      deps.logger.warn(
        { tenantId: event.tenant_id },
        'Sample data removal had no requester, so it was not done',
      );
      return;
    }

    const actor = await loadActor(tx, event.actor_id, event.tenant_id);
    if (actor === null || !can(actor, 'update', { objectType: 'tenant_settings' }).allowed) {
      deps.logger.warn(
        { tenantId: event.tenant_id, userId: event.actor_id },
        'The requester can no longer change company setup, so sample data was not removed',
      );
      return;
    }

    const result = await removeSampleData(tx, {
      tenantId: event.tenant_id,
      actorId: event.actor_id,
    });
    deps.logger.info(
      { tenantId: event.tenant_id, removed: result.removed, kept: result.kept },
      'Sample data removed',
    );
  };
}
