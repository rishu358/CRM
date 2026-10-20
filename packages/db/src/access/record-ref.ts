import type { Actor, RecordRef } from '@crm/core';
import type { Tx } from '../client.js';
import { teamIdsByUser } from './records.js';

/**
 * The `RecordRef` a record-level `can()` call needs (ADR-0031).
 *
 * `team` scope means "owned by me, or by anyone in one of my teams" — that is
 * what `constraintToSql` puts in every list's WHERE clause. A record has no
 * team column, so the in-memory twin of that rule needs the **owner's teams**,
 * and for a long time no service supplied them: a team-scope user could see a
 * teammate's contact in the list and got a 404 opening it. The access explainer
 * made that impossible to leave alone, because it can only tell an
 * administrator the truth if the list, the record page and the explanation all
 * apply one rule.
 *
 * The lookup is skipped when it cannot change the answer: nobody to look up,
 * the actor is the owner, or the actor belongs to no team and so cannot share
 * one. That keeps the common case (an `own` or `all` actor) at zero extra
 * queries.
 */
export async function recordRefFor(
  tx: Tx,
  actor: Actor,
  ownerId: string | null,
): Promise<RecordRef> {
  if (ownerId === null || ownerId === actor.userId || actor.teamIds.length === 0) {
    return { ownerId };
  }
  const teams = await teamIdsByUser(tx, actor.tenantId, [ownerId]);
  return { ownerId, ownerTeamIds: teams.get(ownerId) ?? [] };
}
