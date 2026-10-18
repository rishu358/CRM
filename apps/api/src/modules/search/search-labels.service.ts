import { Inject, Injectable } from '@nestjs/common';
import type { Actor, SearchableObjectType } from '@crm/core';
import type { Tx } from '@crm/db';
import { AccountsService } from '../accounts/accounts.service.js';
import { ActivitiesService } from '../activities/activities.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { DealsService } from '../deals/deals.service.js';
import { LeadsService } from '../leads/leads.service.js';

/**
 * Turns a search hit back into a record the caller may actually see
 * (ADR-0028 §5).
 *
 * The index already carries the tenant, the owner and the field keys, and the
 * provider applied all three in SQL — so this is not where visibility is
 * decided. It exists for two reasons the index cannot cover on its own:
 *
 *  1. **The index is eventually consistent.** A record reassigned out of the
 *     caller's scope, or soft-deleted, stops being visible the moment it is
 *     written; its index rows change a moment later, when the relay gets to
 *     the event (ADR-0006). Asking the owning module for the record closes
 *     that window, so a hit that no longer resolves is simply dropped.
 *  2. **A title has to be built from readable fields.** Each module already
 *     knows how to do that — it is the same `linkLabels` an activity link
 *     uses (ADR-0005) — and it is the module's job, not search's, because
 *     only it knows which of its columns the label is made of.
 *
 * It asks through each module's **service**, never its repository or tables
 * (ADR-0001, CLAUDE.md §3), and batches by object type, so a page of results
 * costs at most five queries rather than one per hit.
 */
@Injectable()
export class SearchLabelsService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(DealsService) private readonly deals: DealsService,
    @Inject(ActivitiesService) private readonly activities: ActivitiesService,
  ) {}

  /**
   * Labels for the records behind these hits, keyed `objectType:recordId`.
   *
   * A hit with no entry in the result is one the caller may not read *now*,
   * whatever the index still says, and the serializer drops it.
   */
  async resolve(
    tx: Tx,
    actor: Actor,
    refs: readonly { objectType: SearchableObjectType; recordId: string }[],
  ): Promise<Map<string, string>> {
    const byType = new Map<SearchableObjectType, Set<string>>();
    for (const ref of refs) {
      const ids = byType.get(ref.objectType) ?? new Set<string>();
      ids.add(ref.recordId);
      byType.set(ref.objectType, ids);
    }

    const labels = new Map<string, string>();

    // Sequentially, not Promise.all: a transaction is one connection, and
    // concurrent queries on a single pg client are deprecated and will throw.
    for (const [objectType, ids] of byType) {
      const resolved = await this.labelsFor(tx, actor, objectType, [...ids]);
      for (const [recordId, label] of resolved) {
        labels.set(labelKey(objectType, recordId), label);
      }
    }

    return labels;
  }

  private labelsFor(
    tx: Tx,
    actor: Actor,
    objectType: SearchableObjectType,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    switch (objectType) {
      case 'account':
        return this.accounts.linkLabels(tx, actor, ids);
      case 'contact':
        return this.contacts.linkLabels(tx, actor, ids);
      case 'lead':
        return this.leads.linkLabels(tx, actor, ids);
      case 'deal':
        return this.deals.linkLabels(tx, actor, ids);
      case 'activity':
        return this.activities.linkLabels(tx, actor, ids);
    }
  }
}

/** The key both halves of a resolved hit agree on. */
export function labelKey(objectType: string, recordId: string): string {
  return `${objectType}:${recordId}`;
}
