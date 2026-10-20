import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, type Action, type Actor, type AttachmentTargetType } from '@crm/core';
import type { Tx } from '@crm/db';
import { AccountsService } from '../accounts/accounts.service.js';
import { ActivitiesService } from '../activities/activities.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { DealsService } from '../deals/deals.service.js';
import { LeadsService } from '../leads/leads.service.js';

/**
 * The one place an attachment's `(object_type, record_id)` is judged
 * (ADR-0005, ADR-0035).
 *
 * ADR-0005 gave up the database foreign key on the target side, which makes
 * referential integrity and visibility the application's job. For attachments
 * both of those reduce to a single question asked of whoever owns the record:
 * *may this actor do this to it?* Nothing else about the target is needed —
 * an attachment panel shows files, not the record it is sitting on — so this
 * service deliberately asks for a yes or no and not for a row.
 *
 * It asks through each module's **service**, never its repository or tables
 * (CLAUDE.md §3), and the dependency runs one way: none of the five modules
 * knows attachments exist, so all five can still be split out later.
 *
 * `assert` raises 404, never 403, for a record the actor cannot reach. A 403
 * would confirm the id exists and turn the pair into an existence oracle for
 * records in other tenants or other reps' books (CLAUDE.md §5.5) — which is
 * the precise way a polymorphic link becomes a way around record scope.
 */
@Injectable()
export class AttachmentTargetsService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(DealsService) private readonly deals: DealsService,
    @Inject(ActivitiesService) private readonly activities: ActivitiesService,
  ) {}

  /**
   * Whether the actor may take `action` on the target record.
   *
   * `read` is what listing and downloading require; `update` is what attaching
   * and removing require, because adding a file to a record changes it. There
   * is no separate attachment grant: a file is part of the record it hangs
   * from, and inventing a second axis of permission for it would mean an admin
   * could grant "attach" on records the grantee cannot even see.
   */
  allows(
    tx: Tx,
    actor: Actor,
    action: Action,
    objectType: AttachmentTargetType,
    recordId: string,
  ): Promise<boolean> {
    switch (objectType) {
      case 'account':
        return this.accounts.allowsRecordAction(tx, actor, action, recordId);
      case 'contact':
        return this.contacts.allowsRecordAction(tx, actor, action, recordId);
      case 'lead':
        return this.leads.allowsRecordAction(tx, actor, action, recordId);
      case 'deal':
        return this.deals.allowsRecordAction(tx, actor, action, recordId);
      case 'activity':
        return this.activities.allowsRecordAction(tx, actor, action, recordId);
    }
  }

  /** The same question, raising 404 when the answer is no. */
  async assert(
    tx: Tx,
    actor: Actor,
    action: Action,
    objectType: AttachmentTargetType,
    recordId: string,
  ): Promise<void> {
    if (!(await this.allows(tx, actor, action, objectType, recordId))) {
      throw new NotFoundError(objectType);
    }
  }
}
