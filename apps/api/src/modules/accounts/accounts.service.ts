import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  can,
  canReadField,
  COMPANY_NAME_SIMILARITY_THRESHOLD,
  MAX_DUPLICATE_MATCHES,
  money,
  newId,
  NotFoundError,
  RecordMergedError,
  ValidationError,
  VersionConflictError,
  type Action,
  type Actor,
  type FieldDefinition,
  type RecordConstraint,
} from '@crm/core';
import {
  parseFilter,
  parseSort,
  toFilterList,
  type AccountCreateInput,
  type AccountDuplicateCheckInput,
  type AccountListQuery,
  type AccountUpdateInput,
  type DuplicateMatch,
  type MoneyInput,
} from '@crm/contracts';
import { findMergePointer, recordRefFor, type Account as AccountRow, type Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { assertFiltersReadable, assertSortable } from '../../common/field-queries.js';
import { searchForList } from '../../common/record-search.js';
import { SEARCH_PROVIDER, type ApiSearchProvider } from '../../platform/search/search.tokens.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { IdempotencyService } from '../../platform/idempotency.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { AccountsRepository } from './accounts.repository.js';
import {
  assertWritableAccountFields,
  serializeAccount,
  serializeAccounts,
  type SerializedAccount,
} from './accounts.serializer.js';
import { allowedSortKeys } from './accounts.sql-helpers.js';

/**
 * Accounts business logic (CLAUDE.md §11.2).
 *
 * The same five steps the contacts service established, in the same order:
 *   1. authorize with `can()` before anything else
 *   2. validate custom fields against this tenant's metadata
 *   3. check field-level write permission
 *   4. do the write, the audit entry and the outbox event in ONE transaction
 *   5. serialize through the field-permission filter on the way out
 *
 * Two things are genuinely this module's own rather than copied:
 *
 * **The parent link.** `parent_account_id` points back into this table, so a
 * value that passes Zod can still be an account in another tenant, a deleted
 * one, the record itself, or one of its own descendants. The last of those
 * creates a cycle, which does not corrupt a row — it makes any later walk of
 * the hierarchy fail to terminate. It is settled here *and* by a database
 * trigger, for the reasons in ADR-0018; this layer exists to turn the refusal
 * into a sentence someone can act on.
 *
 * **Revenue.** An amount is minor units in a bigint beside its currency, never
 * a float and never a bare number (CLAUDE.md §7). `@crm/core/money` is what
 * decides whether a currency code is real.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountsRepository) private readonly repository: AccountsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(SEARCH_PROVIDER) private readonly search: ApiSearchProvider,
  ) {}

  async list(
    actor: Actor,
    query: AccountListQuery,
  ): Promise<{
    data: SerializedAccount[];
    meta: { nextCursor: string | null; hasMore: boolean; truncated?: boolean };
  }> {
    // Collection-level check. The returned constraint becomes a WHERE clause,
    // so `own` scope never fetches another rep's rows in the first place.
    const decision = assertCan(actor, 'read', { objectType: 'account' });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'account');

      const sort = query.sort === undefined ? undefined : parseSort(query.sort);
      if (sort !== undefined) {
        assertSortable(actor, 'account', sort.field, allowedSortKeys(fields));
      }

      const filters = toFilterList(query.filter).map((raw) => {
        const parsed = parseFilter(raw);
        if (parsed === null) {
          throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
        }
        return parsed;
      });
      assertFiltersReadable(actor, 'account', filters);

      const constraint: RecordConstraint = decision.allowed
        ? decision.constraint
        : { kind: 'own', userId: actor.userId };
      const matched = await searchForList(this.search, tx, actor, 'account', constraint, query.q);

      const result = await this.repository.list(tx, actor.tenantId, {
        constraint,
        limit: query.limit,
        cursor: query.cursor,
        sort,
        filters,
        matchedIds: matched.matchedIds,
        fields,
      });

      return {
        data: serializeAccounts(actor, result.rows, fields),
        meta: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          ...(matched.truncated ? { truncated: true } : {}),
        },
      };
    });
  }

  async getById(actor: Actor, id: string): Promise<SerializedAccount> {
    return this.inTenant(actor, (tx) => this.getByIdInTx(actor, tx, id));
  }

  /**
   * Read one account inside a transaction somebody else owns, exactly as `getById` does: same
   * permission checks, same 404 for what is out of scope, same serializer. A replayed
   * `Idempotency-Key` re-reads the record it created through this (ADR-0060).
   */
  async getByIdInTx(actor: Actor, tx: Tx, id: string): Promise<SerializedAccount> {
    assertCan(actor, 'read', { objectType: 'account' });

    const row = await this.loadOrMerged(tx, actor, id);
    // Record-level check. Out of scope raises 404, not 403, so the endpoint
    // cannot be used to discover that an id exists (CLAUDE.md §5.5).
    assertCan(actor, 'read', {
      objectType: 'account',
      record: await recordRefFor(tx, actor, row.ownerId),
    });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'account');
    return serializeAccount(actor, row, fields);
  }

  async create(actor: Actor, input: AccountCreateInput): Promise<SerializedAccount> {
    return this.inTenant(actor, (tx) => this.createInTx(actor, tx, input));
  }

  /**
   * Create an account, and report which existing accounts it may duplicate (ADR-0023): the same
   * domain, or a name that is close. Offered, never imposed, and looked up before the insert in the
   * same transaction so the new row cannot match itself. See `ContactsService.createWithDuplicates`.
   */
  async createWithDuplicates(
    actor: Actor,
    input: AccountCreateInput,
    idempotencyKey?: string,
  ): Promise<{ account: SerializedAccount; duplicates: DuplicateMatch[] }> {
    assertCan(actor, 'create', { objectType: 'account' });
    return this.inTenant(actor, (tx) =>
      this.idempotency.once(
        tx,
        actor,
        idempotencyKey,
        { objectType: 'account', action: 'create' },
        input,
        async () => {
          const duplicates = await this.findDuplicates(tx, actor, {
            domain: input.domain,
            name: input.name,
          });
          const account = await this.createInTx(actor, tx, input);
          return {
            answer: { account, duplicates },
            reference: { recordId: account['id'] as string },
          };
        },
        async (reference) => {
          const account = await this.getByIdInTx(actor, tx, reference.recordId);
          const duplicates = await this.findDuplicates(tx, actor, {
            domain: account['domain'] as string | null | undefined,
            name: account['name'] as string | null | undefined,
          });
          return { account, duplicates: duplicates.filter((m) => m.id !== reference.recordId) };
        },
      ),
    );
  }

  /**
   * What would this account duplicate, before it is saved? Needs `create` on accounts (ADR-0023
   * rule 5). Nothing is written.
   */
  async checkDuplicates(
    actor: Actor,
    input: AccountDuplicateCheckInput,
  ): Promise<DuplicateMatch[]> {
    assertCan(actor, 'create', { objectType: 'account' });
    return this.inTenant(actor, (tx) => this.findDuplicates(tx, actor, input));
  }

  /**
   * Create a account inside a transaction somebody else owns.
   *
   * Lead conversion creates several records and must be all-or-nothing, so it
   * needs the very same checks, audit entry and outbox event `create` performs,
   * without opening a second transaction. Every guarantee `create` gives holds
   * here too: it is the same code, not a copy of it.
   */
  async createInTx(actor: Actor, tx: Tx, input: AccountCreateInput): Promise<SerializedAccount> {
    assertCan(actor, 'create', { objectType: 'account' });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'account');
    assertWritableAccountFields(actor, input, fields);

    const customFields = this.validateCustomFields(input.customFields ?? {}, fields, false);
    const ownerId = this.resolveOwner(actor, input.ownerId ?? undefined);
    const revenue = toRevenueColumns(input.annualRevenue ?? null);

    const id = newId();
    if (input.parentAccountId != null) {
      await this.assertParentIsUsable(tx, actor, id, input.parentAccountId);
    }

    const row = await this.withCycleTranslated(() =>
      this.repository.insert(tx, {
        id,
        tenantId: actor.tenantId,
        ownerId,
        name: input.name,
        domain: input.domain ?? null,
        industry: input.industry ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        website: input.website ?? null,
        gstin: input.gstin ?? null,
        billingAddress: input.billingAddress ?? null,
        shippingAddress: input.shippingAddress ?? null,
        ...revenue,
        employeeCount: input.employeeCount ?? null,
        parentAccountId: input.parentAccountId ?? null,
        customFields,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      }),
    );

    // Same transaction as the insert: the audit entry and the event exist if
    // and only if the account does (CLAUDE.md §5.10, ADR-0006).
    await this.audit.record(tx, actor, {
      action: 'create',
      objectType: 'account',
      recordId: row.id,
      changes: diffChanges(
        {},
        {
          name: row.name,
          domain: row.domain,
          ownerId: row.ownerId,
          parentAccountId: row.parentAccountId,
        },
      ),
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'account.created.v1',
      objectType: 'account',
      recordId: row.id,
      payload: { ownerId: row.ownerId, parentAccountId: row.parentAccountId },
    });

    return serializeAccount(actor, row, fields);
  }

  async update(actor: Actor, id: string, input: AccountUpdateInput): Promise<SerializedAccount> {
    assertCan(actor, 'update', { objectType: 'account' });

    return this.inTenant(actor, (tx) => this.updateInTx(actor, tx, id, input));
  }

  /**
   * Update a account inside a transaction somebody else owns.
   *
   * Bulk edit changes many records and reports each one's outcome, so it needs
   * the very same checks, version guard, audit entry and outbox event `update`
   * performs, without opening a second transaction. Every guarantee `update`
   * gives holds here too: it is the same code, not a copy of it (ADR-0056).
   */
  async updateInTx(
    actor: Actor,
    tx: Tx,
    id: string,
    input: AccountUpdateInput,
  ): Promise<SerializedAccount> {
    assertCan(actor, 'update', { objectType: 'account' });

    const existing = await this.loadOrNotFound(tx, actor, id);
    assertCan(actor, 'update', {
      objectType: 'account',
      record: await recordRefFor(tx, actor, existing.ownerId),
    });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'account');
    assertWritableAccountFields(actor, input, fields);

    if (input.parentAccountId != null) {
      await this.assertParentIsUsable(tx, actor, id, input.parentAccountId);
    }

    const patch = this.buildPatch(actor, input, existing, fields);

    const updated = await this.withCycleTranslated(() =>
      this.repository.updateWithVersion(tx, actor.tenantId, id, input.version, {
        ...patch,
        updatedBy: actor.userId,
      }),
    );

    if (updated === null) {
      // The row exists — we just loaded it — so a zero-row update means the
      // version moved: somebody else saved first. 409, never a silent clobber.
      throw new VersionConflictError('account');
    }

    const changes = diffChanges(existing, updated);

    await this.audit.record(tx, actor, {
      action: 'update',
      objectType: 'account',
      recordId: id,
      changes,
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'account.updated.v1',
      objectType: 'account',
      recordId: id,
      payload: { changedFields: Object.keys(changes) },
    });

    return serializeAccount(actor, updated, fields);
  }

  /**
   * Soft delete.
   *
   * An account with children can be deleted, and its children keep pointing at
   * it (ADR-0018). The alternatives are both worse: refusing would make a
   * parent undeletable until somebody reparents every branch by hand, and
   * nulling the children's link would destroy the hierarchy irreversibly in a
   * Recycle Bin whose whole promise is that a delete can be undone.
   */
  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'account' });

    await this.inTenant(actor, (tx) => this.removeInTx(actor, tx, id, version));
  }

  /**
   * Soft-delete a account inside a transaction somebody else owns (see `updateInTx`).
   */
  async removeInTx(actor: Actor, tx: Tx, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'account' });

    const existing = await this.loadOrNotFound(tx, actor, id);
    assertCan(actor, 'delete', {
      objectType: 'account',
      record: await recordRefFor(tx, actor, existing.ownerId),
    });

    const deleted = await this.repository.softDelete(tx, actor.tenantId, id, actor.userId, version);
    if (deleted === null) throw new VersionConflictError('account');

    await this.audit.record(tx, actor, {
      action: 'delete',
      objectType: 'account',
      recordId: id,
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'account.deleted.v1',
      objectType: 'account',
      recordId: id,
    });
  }

  /**
   * Does this id name an account another module may link to?
   *
   * The public way in. Contacts and, later, deals and leads hold an
   * `account_id`, and they check it through here rather than by querying the
   * accounts table, which is the boundary that lets this module become a
   * service later (ADR-0001, CLAUDE.md §3).
   */
  async existsForLinking(tx: Tx, tenantId: string, accountId: string): Promise<boolean> {
    return this.repository.existsLive(tx, tenantId, accountId);
  }

  /**
   * Accounts this company might already be (ADR-0023): the same domain, or a
   * name that is close under pg_trgm.
   *
   * The same three guarantees as `ContactsService.findDuplicates`, for the same
   * reasons: only fields the actor may read are matched on, only accounts in
   * the actor's record scope are returned, and the label shows nothing the
   * actor could not read. No permission on accounts is an empty answer.
   */
  async findDuplicates(
    tx: Tx,
    actor: Actor,
    criteria: {
      readonly domain?: string | null | undefined;
      readonly name?: string | null | undefined;
    },
  ): Promise<DuplicateMatch[]> {
    const decision = can(actor, 'read', { objectType: 'account' });
    if (!decision.allowed) return [];

    const domain =
      criteria.domain != null && canReadField(actor, 'account', 'domain')
        ? criteria.domain
        : undefined;
    const name =
      criteria.name != null && canReadField(actor, 'account', 'name') ? criteria.name : undefined;

    const rows = await this.repository.findDuplicates(
      tx,
      actor.tenantId,
      { domain, name },
      decision.constraint,
      COMPANY_NAME_SIMILARITY_THRESHOLD,
      MAX_DUPLICATE_MATCHES,
    );

    return rows.map((row) => {
      const matchedOn: DuplicateMatch['matchedOn'] = [];
      if (domain !== undefined && row.domain?.toLowerCase() === domain.toLowerCase()) {
        matchedOn.push('domain');
      }
      if (
        name !== undefined &&
        row.nameScore !== null &&
        row.nameScore >= COMPANY_NAME_SIMILARITY_THRESHOLD
      ) {
        matchedOn.push('name');
      }
      return {
        objectType: 'account',
        id: row.id,
        label: canReadField(actor, 'account', 'name') ? row.name : 'Account',
        matchedOn,
      };
    });
  }

  /**
   * An account the caller may attach something to, or a 422. Narrower than
   * `existsForLinking` for the reason given on
   * `ContactsService.assertReadableForLinking`.
   */
  async assertReadableForLinking(
    tx: Tx,
    actor: Actor,
    id: string,
    path: string,
  ): Promise<{ id: string }> {
    const decision = can(actor, 'read', { objectType: 'account' });
    const row = decision.allowed
      ? await this.repository.findReadable(tx, actor.tenantId, id, decision.constraint)
      : null;
    if (row === null) {
      throw new ValidationError([{ path, message: 'That account does not exist' }]);
    }
    return { id: row.id };
  }

  /**
   * What to call these accounts, for the ones this actor may read (ADR-0005).
   *
   * See `ContactsService.linkLabels`: record scope in SQL, label built only
   * from readable fields, absent rather than refused when either says no.
   */
  async linkLabels(tx: Tx, actor: Actor, ids: readonly string[]): Promise<Map<string, string>> {
    const decision = can(actor, 'read', { objectType: 'account' });
    if (!decision.allowed) return new Map();

    const rows = await this.repository.findReadableMany(
      tx,
      actor.tenantId,
      ids,
      decision.constraint,
    );

    return new Map(
      rows.map((row) => [
        row.id,
        canReadField(actor, 'account', 'name') && row.name.length > 0 ? row.name : 'Account',
      ]),
    );
  }

  /**
   * "May this actor do `action` to this record?"
   *
   * The question a polymorphic feature has to ask of the module that owns the
   * record, because it holds the `(object_type, record_id)` pair and nothing
   * else (ADR-0005). Attachments ask it twice: `read` to list the files on a
   * record, and `update` to add or remove one (ADR-0035).
   *
   * The scope is applied **in SQL**, as the constraint belonging to that
   * action rather than to `read`, so a role with `read: all` and `update: own`
   * can list the files on a colleague's account and not touch them. A
   * record outside the caller's reach is indistinguishable from one that does
   * not exist, which is what stops the polymorphic pair becoming a way around
   * record scope (CLAUDE.md §5.5).
   */
  async allowsRecordAction(tx: Tx, actor: Actor, action: Action, id: string): Promise<boolean> {
    const decision = can(actor, action, { objectType: 'account' });
    if (!decision.allowed) return false;

    const rows = await this.repository.findReadableMany(
      tx,
      actor.tenantId,
      [id],
      decision.constraint,
    );
    return rows.length > 0;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }

  /**
   * Load a account for a read, or say why it is not there.
   *
   * A account that was merged into another is answered with 410 and the surviving record's id (ADR-0064), so
   * an old link or API id leads somewhere. Only when the caller could have read **both** the merged-away
   * record and the survivor: otherwise it is the plain 404 of any record they cannot see, so an old id
   * cannot be used to find out what exists (CLAUDE.md §5.5). After the Recycle Bin purge the merged-away
   * record's owner is unknown and the survivor's visibility alone decides.
   */
  private async loadOrMerged(tx: Tx, actor: Actor, id: string): Promise<AccountRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row !== null) return row;

    const decision = can(actor, 'read', { objectType: 'account' });
    if (decision.allowed) {
      const pointer = await findMergePointer(tx, actor.tenantId, 'account', id);
      if (pointer !== null) {
        const oldVisible =
          pointer.loserOwnerId === null ||
          can(actor, 'read', {
            objectType: 'account',
            record: await recordRefFor(tx, actor, pointer.loserOwnerId),
          }).allowed;
        const survivor = oldVisible
          ? await this.repository.findReadable(
              tx,
              actor.tenantId,
              pointer.masterId,
              decision.constraint,
            )
          : null;
        if (survivor !== null) throw new RecordMergedError('account', pointer.masterId);
      }
    }
    throw new NotFoundError('Account');
  }

  /**
   * The duplicates of one account, for the "Possible duplicates" card and its Merge button (ADR-0064).
   *
   * The record's own identifying values go through `findDuplicates`, so it keeps every rule that
   * method has (fields the caller may read, records in their scope, labels they may read). The record
   * itself is never in the answer. Needs `update`: the only use of the list is to merge, and a
   * role that cannot change a record has no use for it.
   */
  async duplicatesOf(actor: Actor, id: string): Promise<DuplicateMatch[]> {
    assertCan(actor, 'update', { objectType: 'account' });
    return this.inTenant(actor, async (tx) => {
      const record = await this.getByIdInTx(actor, tx, id);
      const found = await this.findDuplicates(tx, actor, {
        domain: record['domain'] as string | null | undefined,
        name: record['name'] as string | null | undefined,
      });
      return found.filter((match) => match.id !== id);
    });
  }

  /**
   * Load a record or raise 404.
   *
   * RLS has already excluded other tenants, so "not found" covers both a
   * genuinely missing record and one belonging to someone else —
   * indistinguishable from outside, which is the point (CLAUDE.md §5.5).
   */
  private async loadOrNotFound(tx: Tx, actor: Actor, id: string): Promise<AccountRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row === null) throw new NotFoundError('Account');
    return row;
  }

  /**
   * Can `childId` be placed under `parentId`?
   *
   * Three refusals, all 422 on the `parentAccountId` path:
   *   * the parent is the record itself
   *   * the parent is not a live account in this tenant
   *   * the parent is already a descendant, so the link would close a cycle
   *
   * Scoped to the tenant, not to the actor's record scope. A rep with `own`
   * scope must be able to file their account under the group company their
   * manager owns; requiring the parent to be visible to them would make the
   * hierarchy unusable for exactly the people who maintain it. The reference
   * leaks nothing by itself — reading the parent still goes through
   * `getById`, which applies record scope — and the ids are UUIDv7, so this
   * is not a lookup anyone can walk.
   */
  private async assertParentIsUsable(
    tx: Tx,
    actor: Actor,
    childId: string,
    parentId: string,
  ): Promise<void> {
    const reject = (message: string): never => {
      throw new ValidationError([{ path: 'parentAccountId', message }]);
    };

    if (parentId === childId) reject('An account cannot be its own parent');

    if (!(await this.repository.existsLive(tx, actor.tenantId, parentId))) {
      // The same message whether the id belongs to another tenant or to
      // nothing at all, for the same reason getById returns 404 for both.
      reject('That parent account does not exist');
    }

    const ancestors = await this.repository.ancestorIds(tx, actor.tenantId, parentId);
    if (ancestors.includes(childId)) {
      reject('That account is already below this one, so it cannot also be its parent');
    }
  }

  /**
   * Turn the database's cycle refusal into the module's own error.
   *
   * The service check above catches every cycle a single request can create.
   * This catches the one it cannot: two concurrent requests, each adding one
   * half of a loop. The trigger serialises them and refuses the second
   * (ADR-0018), and without this the caller would receive a 500 for what is
   * plainly a 422.
   */
  private async withCycleTranslated<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isConstraintViolation(error, 'accounts_parent_cycle')) {
        throw new ValidationError([
          {
            path: 'parentAccountId',
            message: 'That account is already below this one, so it cannot also be its parent',
          },
        ]);
      }
      throw error;
    }
  }

  private validateCustomFields(
    input: Record<string, unknown>,
    fields: readonly FieldDefinition[],
    partial: boolean,
  ): Record<string, unknown> {
    const custom = fields.filter((field) => !field.isSystem);
    const schema = partial ? buildCustomFieldsPatchSchema(custom) : buildCustomFieldsSchema(custom);

    const result = schema.safeParse(input);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((issue) => ({
          path: `customFields.${issue.path.join('.')}`,
          message: issue.message,
        })),
      );
    }
    return result.data;
  }

  /**
   * Decide who owns a new or reassigned record.
   *
   * Assigning to somebody else is a reassignment, which needs `all` scope.
   * Otherwise a rep with `own` scope could push a record out of their own
   * visibility, or into a colleague's, just by naming a different owner.
   */
  private resolveOwner(actor: Actor, requestedOwnerId: string | undefined): string {
    if (requestedOwnerId === undefined || requestedOwnerId === actor.userId) {
      return actor.userId;
    }
    const decision = can(actor, 'update', { objectType: 'account' });
    if (!decision.allowed || decision.scope !== 'all') {
      throw new ValidationError([
        { path: 'ownerId', message: 'You cannot assign records to another user' },
      ]);
    }
    return requestedOwnerId;
  }

  private buildPatch(
    actor: Actor,
    input: AccountUpdateInput,
    existing: AccountRow,
    fields: readonly FieldDefinition[],
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    for (const key of [
      'name',
      'domain',
      'industry',
      'phone',
      'email',
      'website',
      'gstin',
      'billingAddress',
      'shippingAddress',
      'employeeCount',
      'parentAccountId',
    ] as const) {
      if (key in input) patch[key] = input[key] ?? null;
    }

    // The two revenue columns move together or not at all, so that a PATCH can
    // never leave an amount without its currency — which the table's CHECK
    // would refuse anyway, as a 500 rather than an explanation.
    if ('annualRevenue' in input) {
      Object.assign(patch, toRevenueColumns(input.annualRevenue ?? null));
    }

    if (input.ownerId !== undefined) {
      patch['ownerId'] = this.resolveOwner(actor, input.ownerId ?? undefined);
    }

    if (input.customFields !== undefined) {
      const validated = this.validateCustomFields(input.customFields, fields, true);
      // Merge rather than replace: a PATCH naming one custom field must not
      // wipe the others the caller never mentioned.
      patch['customFields'] = { ...existing.customFields, ...validated };
    }

    return patch;
  }
}

/**
 * The wire shape of money, as the two columns that store it.
 *
 * `money()` from @crm/core is what rejects an invented currency code; doing
 * the check with a regex here would be a second, slightly different opinion
 * about what ISO-4217 means.
 */
function toRevenueColumns(input: MoneyInput | null): {
  annualRevenueMinor: bigint | null;
  annualRevenueCurrency: string | null;
} {
  if (input === null) {
    return { annualRevenueMinor: null, annualRevenueCurrency: null };
  }

  try {
    const amount = money(BigInt(input.amountMinor), input.currency);
    return { annualRevenueMinor: amount.amountMinor, annualRevenueCurrency: amount.currency };
  } catch {
    throw new ValidationError([
      { path: 'annualRevenue.currency', message: 'Must be an ISO-4217 currency code' },
    ]);
  }
}
