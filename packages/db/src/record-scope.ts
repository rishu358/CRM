import type { RecordConstraint } from '@crm/core';
import { or, sql, type SQL } from 'drizzle-orm';

/**
 * Translate the actor's record scope into a WHERE clause (ADR-0008).
 *
 * Applied in SQL rather than by filtering fetched rows: filtering afterwards
 * would page over records the actor cannot see, so a page of 50 could come
 * back with 3 rows and the cursor would land in the wrong place (ADR-0012).
 *
 * Shared rather than written per module. It was identical in contacts and
 * accounts apart from which table's `owner_id` it names, and the one piece of
 * it that is easy to get wrong — that `team` scope means "owned by anyone in
 * my teams **or** by me", not just the former — is the piece a third copy
 * would eventually get wrong silently.
 *
 * It lives in `@crm/db` rather than in the API because the Postgres search
 * provider needs exactly the same translation and is not part of the API
 * (ADR-0028). `apps/api/src/common/record-scope.ts` re-exports it, so every
 * module's call site is unchanged.
 *
 * The owner column is passed as a SQL fragment rather than a Drizzle column so
 * that no module has to import a type from `drizzle-orm` directly (ADR-0017).
 */
export function constraintToSql(constraint: RecordConstraint, ownerColumn: SQL): SQL | undefined {
  switch (constraint.kind) {
    case 'all':
      return undefined;
    case 'own':
      return sql`${ownerColumn} = ${constraint.userId}::uuid`;
    case 'team': {
      // Team membership of a record is derived from its owner's teams, so this
      // reads through team_members rather than a column on the record.
      const mine = sql`${ownerColumn} = ${constraint.userId}::uuid`;
      if (constraint.teamIds.length === 0) return mine;

      const ownTeams = sql`
        ${ownerColumn} in (
          select tm.user_id from team_members tm
          where tm.team_id in (${sql.join(
            constraint.teamIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        )
      `;
      return or(mine, ownTeams);
    }
  }
}
