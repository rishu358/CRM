import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@crm/db';
import { AccessRepository } from './access.repository.js';

/**
 * Who a number belongs to (ADR-0038).
 *
 * The one public door the access module offers other modules for people. It
 * answers a single question — what is this person called — for the ids it is
 * given, and only for active members of the caller's company. It does not list,
 * search or return an address, a role or a status, so a screen that must name
 * the owner of a figure can do so without the member list's administrator-only
 * rule being bypassed.
 *
 * It does **not** authorize. The caller has already decided that this person's
 * work is visible to this reader (the leaderboard only asks about owners of
 * deals inside the reader's scope); this answers what the label is.
 */
@Injectable()
export class MemberDirectory {
  constructor(@Inject(AccessRepository) private readonly repository: AccessRepository) {}

  async displayNames(
    tx: Tx,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    return this.repository.activeMemberNames(tx, tenantId, [...new Set(userIds)]);
  }
}
