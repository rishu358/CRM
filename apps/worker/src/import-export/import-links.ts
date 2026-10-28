import {
  can,
  canImportLink,
  type Actor,
  type ImportableObjectType,
  type ObjectType,
} from '@crm/core';
import {
  constraintToSql,
  loadActors,
  OBJECT_DESCRIPTORS,
  sql,
  teamIdsByUser,
  type RecordRow,
  type Tx,
} from '@crm/db';

/**
 * The two columns that point at something else: the owner and, for a contact, the account
 * (ADR-0067).
 *
 * A spreadsheet has no ids, so a cell names the owner by e-mail address and the account by name,
 * domain or id, and the names are turned into ids here, **once per chunk and not once per row**:
 * every distinct value in the chunk is looked up with one query, so 500 rows cost three queries,
 * not 1,500.
 *
 * Every lookup runs inside the importing actor's own reach, and says the same thing for "does not
 * exist" and "you may not have it":
 *
 *   - an account is found only among accounts the actor may read (the rule a form's account
 *     picker applies), so a colleague's account in a book the actor cannot see is "no account
 *     matches", not "that account exists but is not yours";
 *   - an owner must be somebody this actor could reassign a record to: an active member who can
 *     see that kind of record and, on `team` scope, the actor or a teammate. Anyone else, member
 *     or not, is "Unknown member", so a file is not a way to find out who works here.
 *
 * Nothing is guessed. Two accounts that share a name, or a name that is one account's name and
 * another's domain, is an error naming the cell, never "the first one".
 */

export const OWNER_KEY = 'owner_id';
export const ACCOUNT_KEY = 'account_id';

export interface LinkCell {
  readonly key: string;
  readonly value: string;
}

export interface LinkResolution {
  /** The id a cell value resolved to, by key and then by the value as typed. */
  readonly ids: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** What is wrong with a value, by key and then by the value as typed. */
  readonly problems: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function linkValueKey(key: string, raw: string): string {
  return key === OWNER_KEY ? raw.trim().toLowerCase() : raw.trim();
}

export async function resolveLinks(
  tx: Tx,
  actor: Actor,
  objectType: ImportableObjectType,
  cells: readonly LinkCell[],
): Promise<LinkResolution> {
  const ids = new Map<string, Map<string, string>>();
  const problems = new Map<string, Map<string, string>>();
  const note = (
    map: Map<string, Map<string, string>>,
    key: string,
    value: string,
    text: string,
  ) => {
    const inner = map.get(key) ?? new Map<string, string>();
    inner.set(value, text);
    map.set(key, inner);
  };

  const distinct = (key: string): string[] => [
    ...new Set(
      cells.filter((cell) => cell.key === key).map((cell) => linkValueKey(key, cell.value)),
    ),
  ];

  const owners = distinct(OWNER_KEY);
  if (owners.length > 0) {
    await resolveOwners(tx, actor, objectType, owners, (value, id, problem) =>
      id === null ? note(problems, OWNER_KEY, value, problem) : note(ids, OWNER_KEY, value, id),
    );
  }

  const accounts = distinct(ACCOUNT_KEY);
  if (accounts.length > 0) {
    await resolveAccounts(tx, actor, accounts, (value, id, problem) =>
      id === null ? note(problems, ACCOUNT_KEY, value, problem) : note(ids, ACCOUNT_KEY, value, id),
    );
  }
  return { ids, problems };
}

type Report = (value: string, id: string | null, problem: string) => void;

async function resolveOwners(
  tx: Tx,
  actor: Actor,
  objectType: ImportableObjectType,
  emails: readonly string[],
  report: Report,
): Promise<void> {
  const unknown = 'Owner: unknown member';

  // The importer's right to name an owner at all is checked again here, with the permissions
  // loaded for this chunk: a role changed mid-import takes effect on the next one.
  if (!canImportLink(actor, objectType, OWNER_KEY)) {
    for (const email of emails)
      report(email, null, 'Owner: you cannot assign records to another user');
    return;
  }

  const found = (
    await tx.execute(sql`
      select u.id, lower(u.email::text) as email
      from memberships m
      join users u on u.id = m.user_id
      where m.tenant_id = ${actor.tenantId}
        and m.status = 'active'
        and lower(u.email::text) in (${sql.join(
          emails.map((email) => sql`${email}`),
          sql`, `,
        )})
    `)
  ).rows as unknown as { id: string; email: string }[];

  const byEmail = new Map(found.map((row) => [row.email, row.id]));
  const userIds = [...new Set(found.map((row) => row.id))];
  const actors = await loadActors(tx, actor.tenantId, userIds);
  const teams = await teamIdsByUser(tx, actor.tenantId, userIds);
  const object = objectType as ObjectType;
  const update = can(actor, 'update', { objectType: object });

  for (const email of emails) {
    const userId = byEmail.get(email);
    const target = userId === undefined ? undefined : actors.get(userId);
    if (userId === undefined || target === undefined) {
      report(email, null, unknown);
      continue;
    }
    // `team` scope: only the actor or somebody on one of their teams, so what is handed over stays
    // inside the reach that allowed handing it over. Answered as an unknown member.
    const sameTeam = (teams.get(userId) ?? []).some((id) => actor.teamIds.includes(id as never));
    if (update.allowed && update.scope === 'team' && userId !== actor.userId && !sameTeam) {
      report(email, null, unknown);
      continue;
    }
    // A record handed to someone who cannot see that kind of record would vanish from view.
    if (!can(target, 'read', { objectType: object }).allowed) {
      report(email, null, 'Owner: that person cannot see this kind of record');
      continue;
    }
    report(email, userId, '');
  }
}

async function resolveAccounts(
  tx: Tx,
  actor: Actor,
  values: readonly string[],
  report: Report,
): Promise<void> {
  const none = (value: string) => `Account: no account matches "${value}"`;

  const read = can(actor, 'read', { objectType: 'account' });
  if (!read.allowed) {
    for (const value of values) report(value, null, none(value));
    return;
  }

  const descriptor = OBJECT_DESCRIPTORS.account;
  const scope = constraintToSql(read.constraint, descriptor.ownerId);
  const options = scope === undefined ? {} : { scope };

  const byId = values.filter((value) => UUID.test(value)).map((value) => value.toLowerCase());
  const byDomain = [...new Set(values.map((value) => value.toLowerCase()))];

  // Three indexed lookups for the whole chunk: id, domain (lower-cased on write), exact name.
  const hits = new Map<string, Map<string, RecordRow>>();
  const keep = (value: string, record: RecordRow): void => {
    const inner = hits.get(value) ?? new Map<string, RecordRow>();
    inner.set(record['id'] as string, record);
    hits.set(value, inner);
  };

  const run = async (
    matchExpression: ReturnType<typeof descriptor.matchExpression>,
    list: string[],
  ) =>
    list.length === 0
      ? []
      : descriptor.selectByMatch(tx, {
          tenantId: actor.tenantId,
          matchExpression,
          values: list,
          ...options,
        });

  for (const record of await run(sql`${descriptor.id}::text`, byId)) {
    keep(String(record['id']), record);
  }
  for (const record of await run(descriptor.matchExpression('domain'), byDomain)) {
    const domain = record['domain'];
    if (typeof domain === 'string') keep(domain.toLowerCase(), record);
  }
  for (const record of await run(descriptor.matchExpression('name'), [...values])) {
    const name = record['name'];
    if (typeof name === 'string') keep(name, record);
  }

  for (const value of values) {
    const matches = new Map<string, RecordRow>();
    for (const probe of [value, value.toLowerCase()]) {
      for (const [id, record] of hits.get(probe) ?? []) matches.set(id, record);
    }
    if (matches.size === 0) {
      report(value, null, none(value));
    } else if (matches.size > 1) {
      report(
        value,
        null,
        `Account: "${value}" matches ${String(matches.size)} accounts; use the account's domain or ID`,
      );
    } else {
      report(value, [...matches.keys()][0] ?? null, '');
    }
  }
}
