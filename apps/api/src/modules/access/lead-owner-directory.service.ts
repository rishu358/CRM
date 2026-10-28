import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@crm/db';
import { AccessRepository } from './access.repository.js';

/**
 * Who may be given a lead (ADR-0063 10).
 *
 * The second narrow door the access module opens to other modules, beside `MemberDirectory`: it
 * answers one question about people (may this person own and work a lead?) without handing out a
 * list, an address or a role. It decides nothing about who *should* get a lead; the assignment
 * rules do that, and ask this before they hand anyone one.
 */
@Injectable()
export class LeadOwnerDirectory {
  constructor(@Inject(AccessRepository) private readonly repository: AccessRepository) {}

  /** The subset of these people who are active, not deleted, and whose role reads and updates leads. */
  async eligible(tx: Tx, tenantId: string, userIds: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds)];
    return new Set(await this.repository.membersWhoCanWork(tx, tenantId, 'lead', unique));
  }

  /** Is this one person eligible? */
  async isEligible(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
    return (await this.eligible(tx, tenantId, [userId])).has(userId);
  }

  /**
   * The longest-standing eligible member whose role can manage lead forms: the person to give a
   * lead to when nothing else names anybody. Null when the workspace has no such person.
   */
  async longestStandingFormManager(tx: Tx, tenantId: string): Promise<string | null> {
    return this.repository.earliestMemberWith(tx, tenantId, {
      objectType: 'lead_form',
      action: 'update',
    });
  }
}
