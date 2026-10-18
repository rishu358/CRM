import {
  isSearchableObjectType,
  type SearchableObjectType,
  type SearchProvider,
  type Uuid,
} from '@crm/core';
import { buildSearchDocuments, type Tx } from '@crm/db';
import type { EventHandler, OutboxRow } from '../relay.js';

/**
 * Keeps the search index in step with the records (MVP_SPEC §M7, ADR-0028).
 *
 * Driven by the outbox, like the timeline and notifications, and for the same
 * reason: a service that called an indexer inline would be a service somebody
 * eventually forgets to call, and the record would be saved while the index
 * silently disagreed (ADR-0006). Here, anything that writes a record writes an
 * event, and anything that writes an event gets indexed. Nobody has to
 * remember.
 *
 * Both handlers are **idempotent**, as at-least-once delivery requires: the
 * provider replaces a record's documents wholesale, so a redelivered event
 * leaves exactly the same rows.
 *
 * They run inside the relay's tenant-scoped transaction, so RLS applies to the
 * records they read and to the index rows they write (CLAUDE.md §5.1). The
 * worker connects as `crm_worker`, the only role with write access to
 * `search_documents`; the API can read the index and nothing else.
 */

/**
 * Index the record this event is about.
 *
 * Also the delete path in disguise. `buildSearchDocuments` returns nothing for
 * a record that is soft-deleted or gone, and this then **removes** it — so a
 * record that was deleted between the event being written and the relay
 * reaching it ends up unfindable either way, rather than being re-indexed from
 * a row that no longer exists.
 */
export function indexSearchDocument(provider: SearchProvider<Tx>): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const ref = refFor(event);
    if (ref === null) return;

    const documents = await buildSearchDocuments(tx, event.tenant_id, ref.objectType, [
      ref.recordId,
    ]);

    if (documents.length === 0) {
      await provider.remove(tx, event.tenant_id as Uuid, [ref]);
      return;
    }

    await provider.index(tx, event.tenant_id as Uuid, documents);
  };
}

/** Forget the record this event is about. Soft deletes included. */
export function removeSearchDocument(provider: SearchProvider<Tx>): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const ref = refFor(event);
    if (ref === null) return;
    await provider.remove(tx, event.tenant_id as Uuid, [ref]);
  };
}

/**
 * The record an event is about, when it is one search knows how to index.
 *
 * `object_type` comes out of a database column, so it is validated against the
 * closed set in `@crm/core` rather than trusted — the same rule every other
 * polymorphic read follows (CLAUDE.md §5.7). An event about something that is
 * not searchable, such as an invitation, is simply not our business.
 */
function refFor(event: OutboxRow): { objectType: SearchableObjectType; recordId: Uuid } | null {
  if (!isSearchableObjectType(event.object_type) || event.record_id === null) return null;
  return { objectType: event.object_type, recordId: event.record_id as Uuid };
}
