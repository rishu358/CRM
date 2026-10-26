import { Inject, Injectable } from '@nestjs/common';
import type { Actor, LinkTargetType } from '@crm/core';
import type { Tx } from '@crm/db';
import { AccountsService } from '../accounts/accounts.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { DealsService } from '../deals/deals.service.js';
import { LeadsService } from '../leads/leads.service.js';

/**
 * Resolves a polymorphic `(object_type, record_id)` pair (ADR-0005).
 *
 * ADR-0005 gives up database foreign keys on the target side, which makes
 * two things the application's job. This class is where both of them live:
 *
 *   1. **Integrity on write.** Before a link is created the target must
 *      resolve, so a link to a record in another tenant, a deleted record, or
 *      a record the actor cannot see is refused rather than stored.
 *   2. **Visibility on read.** A link is only shown when its target resolves
 *      *for this reader*. An activity the actor may see, attached to a
 *      contact they may not, shows no contact — otherwise the link table
 *      would be a way to enumerate records around record scope, which is
 *      exactly the hole the security suite tests for.
 *
 * It asks each module through its service's public methods, never through
 * another module's repository or tables (ADR-0001, CLAUDE.md §3). The cost of
 * that boundary is one query per object type per page, which is why
 * `linkLabels` is batched rather than per record.
 */
export interface ResolvedRecord {
  readonly objectType: LinkTargetType;
  readonly recordId: string;
  readonly label: string;
}

@Injectable()
export class RecordLinksService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(DealsService) private readonly deals: DealsService,
  ) {}

  /**
   * Resolve many pairs at once, dropping every one the actor may not read.
   *
   * Grouped by object type so a page of fifty activities costs at most four
   * queries rather than one per link.
   */
  async resolveMany(
    tx: Tx,
    actor: Actor,
    refs: readonly { objectType: LinkTargetType; recordId: string }[],
  ): Promise<Map<string, ResolvedRecord>> {
    const byType = new Map<LinkTargetType, Set<string>>();
    for (const ref of refs) {
      const ids = byType.get(ref.objectType) ?? new Set<string>();
      ids.add(ref.recordId);
      byType.set(ref.objectType, ids);
    }

    const resolved = new Map<string, ResolvedRecord>();

    // Sequentially, not Promise.all: a transaction is one connection, and
    // concurrent queries on a single pg client are deprecated and will throw.
    for (const [objectType, ids] of byType) {
      const labels = await this.labelsFor(tx, actor, objectType, [...ids]);
      for (const [recordId, label] of labels) {
        resolved.set(keyFor(objectType, recordId), { objectType, recordId, label });
      }
    }

    return resolved;
  }

  /** One pair, or null when it does not exist for this reader. */
  async resolve(
    tx: Tx,
    actor: Actor,
    objectType: LinkTargetType,
    recordId: string,
  ): Promise<ResolvedRecord | null> {
    const resolved = await this.resolveMany(tx, actor, [{ objectType, recordId }]);
    return resolved.get(keyFor(objectType, recordId)) ?? null;
  }

  private labelsFor(
    tx: Tx,
    actor: Actor,
    objectType: LinkTargetType,
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
    }
  }
}

/** The key both sides of a polymorphic pair agree on. */
export function keyFor(objectType: string, recordId: string): string {
  return `${objectType}:${recordId}`;
}
