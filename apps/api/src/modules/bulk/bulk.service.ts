import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  BULK_MAX_RECORDS,
  can,
  DomainError,
  ForbiddenError,
  newId,
  NotFoundError,
  TAGS_MAX_PER_TENANT,
  ValidationError,
  VersionConflictError,
  type Action,
  type Actor,
  type BusinessObjectType,
  type RecordConstraint,
} from '@crm/core';
import type {
  AccountUpdateInput,
  BulkActionInput,
  BulkResult,
  BulkSkipped,
  BulkTarget,
  ContactUpdateInput,
  DealUpdateInput,
  LeadUpdateInput,
} from '@crm/contracts';
import {
  addRecordTags,
  countTags,
  findTagsByName,
  insertTag,
  loadBulkRows,
  planQuery,
  recordRefFor,
  removeRecordTags,
  sql,
  type BulkRowRef,
  type TagRef,
  type Tx,
} from '@crm/db';
import { assertViewQuery } from '../../common/view-query.js';
import { searchForList } from '../../common/record-search.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { hashRequest, IdempotencyService, reusedKey } from '../../platform/idempotency.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { SEARCH_PROVIDER, type ApiSearchProvider } from '../../platform/search/search.tokens.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { OwnershipService } from '../access/ownership.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { DealsService } from '../deals/deals.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { buildBulkPatch } from './bulk-edit.js';

/** What one object module offers a bulk action. Each is that module's own service method. */
interface ObjectPort {
  update(actor: Actor, tx: Tx, id: string, input: Record<string, unknown>): Promise<unknown>;
  remove(actor: Actor, tx: Tx, id: string, version: number): Promise<void>;
  allows(tx: Tx, actor: Actor, action: Action, id: string): Promise<boolean>;
}

/** Thrown to unwind a dry run's transaction; carries the answer out of it. */
class RolledBack extends Error {
  constructor(readonly result: BulkResult) {
    super('dry run rolled back');
  }
}

interface Outcome {
  readonly changedIds: string[];
  readonly skipped: BulkSkipped[];
}

/**
 * Bulk edit, assign, delete and tag (MVP_SPEC M3 and M4, ADR-0056).
 *
 * ## What a call is
 *
 * One request, **one transaction**, at most `BULK_MAX_RECORDS` records. Each record is attempted
 * inside its own savepoint, so a record that cannot be changed is *skipped and reported* and the
 * rest still go through. That is partial success by design, and the response says exactly what
 * happened: `changedIds`, and `skipped` with a reason per id. An unexpected failure (a database
 * error, a bug) is not a skip: it rolls back the whole call, so nothing is half-written.
 *
 * ## Why it cannot do more than a person can
 *
 * Nothing here has its own idea of who may do what. Each record goes through the same service
 * method a single edit or delete uses (`updateInTx`, `removeInTx`), so `can()` with the record's
 * owner, field-level write permission, the version guard, the audit entry and the outbox event are
 * the same code, not a copy. Assign goes through the ownership service for the same reason. Tags
 * need `update` on the record, asked of the owning module (`allowsRecordAction`).
 *
 * ## What a skip says
 *
 * `not_found` is one answer for an id that is missing, deleted, in another tenant or outside what
 * the caller may see, so a caller cannot use a bulk call to find out which ids exist (CLAUDE.md
 * §5.5). `not_permitted` is said only of a record the caller can already see. A filter target
 * only ever matches what the caller may change, so it reports `not_found` only for a record that
 * vanished mid-call.
 *
 * ## Retries
 *
 * With an `Idempotency-Key`, the answer is stored with the call, in the same transaction, and a
 * retry with the same key and the same request returns it with `replayed: true`. The same key for
 * a different request is refused. A dry run is never stored.
 */
@Injectable()
export class BulkService {
  private readonly ports: Readonly<Record<BusinessObjectType, ObjectPort>>;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(OwnershipService) private readonly ownership: OwnershipService,
    @Inject(SEARCH_PROVIDER) private readonly search: ApiSearchProvider,
    @Inject(ContactsService) contacts: ContactsService,
    @Inject(AccountsService) accounts: AccountsService,
    @Inject(LeadsService) leads: LeadsService,
    @Inject(DealsService) deals: DealsService,
  ) {
    // The `as` casts below are the one place a record's update input is typed by object. The input
    // was parsed by that object's own update schema in `buildBulkPatch`, so it is what the service
    // expects; the version is added per record.
    this.ports = {
      contact: {
        update: (a, tx, id, i) => contacts.updateInTx(a, tx, id, i as ContactUpdateInput),
        remove: (a, tx, id, v) => contacts.removeInTx(a, tx, id, v),
        allows: (tx, a, action, id) => contacts.allowsRecordAction(tx, a, action, id),
      },
      account: {
        update: (a, tx, id, i) => accounts.updateInTx(a, tx, id, i as AccountUpdateInput),
        remove: (a, tx, id, v) => accounts.removeInTx(a, tx, id, v),
        allows: (tx, a, action, id) => accounts.allowsRecordAction(tx, a, action, id),
      },
      lead: {
        update: (a, tx, id, i) => leads.updateInTx(a, tx, id, i as LeadUpdateInput),
        remove: (a, tx, id, v) => leads.removeInTx(a, tx, id, v),
        allows: (tx, a, action, id) => leads.allowsRecordAction(tx, a, action, id),
      },
      deal: {
        update: (a, tx, id, i) => deals.updateInTx(a, tx, id, i as DealUpdateInput),
        remove: (a, tx, id, v) => deals.removeInTx(a, tx, id, v),
        allows: (tx, a, action, id) => deals.allowsRecordAction(tx, a, action, id),
      },
    };
  }

  async run(
    actor: Actor,
    input: BulkActionInput,
    idempotencyKey: string | undefined,
  ): Promise<BulkResult> {
    const needed: Action = input.action === 'delete' ? 'delete' : 'update';
    // The coarse check first, before anything the caller named is looked at.
    const decision = assertCan(actor, needed, { objectType: input.objectType });

    // `assertCan` throws on a denial, so this is the allowed branch; the fallback is the narrowest
    // scope, for the type system and for a future change to what `assertCan` returns.
    const constraint: RecordConstraint = decision.allowed
      ? decision.constraint
      : { kind: 'own', userId: actor.userId };

    const requestHash = hashRequest(input);

    try {
      return await this.inTenant(actor, async (tx) => {
        if (idempotencyKey !== undefined) {
          await this.idempotency.lockKey(tx, actor.tenantId, actor.userId, idempotencyKey);
          const stored = await this.idempotency.find(
            tx,
            actor.tenantId,
            actor.userId,
            idempotencyKey,
          );
          if (stored !== null) {
            if (stored.requestHash !== requestHash) {
              throw reusedKey();
            }
            return { ...(stored.result as unknown as BulkResult), replayed: true };
          }
        }

        const result = await this.execute(tx, actor, input, constraint);

        if (input.dryRun) throw new RolledBack(result);

        if (idempotencyKey !== undefined) {
          await this.idempotency.sweep(tx, actor.tenantId, actor.userId);
          await this.idempotency.insert(tx, {
            id: newId(),
            tenantId: actor.tenantId,
            idempotencyKey,
            objectType: input.objectType,
            action: input.action,
            requestHash,
            result: result,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          });
        }
        return result;
      });
    } catch (error) {
      if (error instanceof RolledBack) return error.result;
      throw error;
    }
  }

  // -------------------------------------------------------------------------

  private async execute(
    tx: Tx,
    actor: Actor,
    input: BulkActionInput,
    constraint: RecordConstraint,
  ): Promise<BulkResult> {
    const { objectType } = input;
    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, objectType);

    // Everything that does not depend on a record is settled before any record is touched.
    const patch =
      input.action === 'edit' ? buildBulkPatch(actor, objectType, fields, input.changes) : null;

    const { ids, nextCursor } = await this.resolveTarget(
      tx,
      actor,
      objectType,
      input.target,
      constraint,
      fields,
    );

    const rows = await loadBulkRows(tx, actor.tenantId, objectType, ids);
    const port = this.ports[objectType];

    let outcome: Outcome;
    switch (input.action) {
      case 'edit':
        outcome = await this.eachRecord(tx, actor, objectType, ids, rows, (sp, id, row) =>
          port
            .update(actor, sp, id, { ...(patch ?? {}), version: row.version })
            .then(() => 'changed'),
        );
        break;
      case 'delete':
        outcome = await this.eachRecord(tx, actor, objectType, ids, rows, (sp, id, row) =>
          port.remove(actor, sp, id, row.version).then(() => 'changed'),
        );
        break;
      case 'assign':
        outcome = await this.assign(tx, actor, objectType, ids, rows, input.ownerId);
        break;
      case 'tag_add':
      case 'tag_remove':
        outcome = await this.tag(tx, actor, objectType, ids, rows, input.action, input.tags);
        break;
    }

    return {
      objectType,
      action: input.action,
      dryRun: input.dryRun,
      matched: ids.length,
      changed: outcome.changedIds.length,
      changedIds: outcome.changedIds,
      skipped: outcome.skipped,
      nextCursor,
      replayed: false,
    };
  }

  /**
   * The ids this call is about: those named, or the next batch the caller's filter matches.
   *
   * A filter is planned by the same `planQuery` an export uses, over the **caller's own scope for
   * this action** (`update` or `delete`), so it only ever matches records they could change. Its
   * fields are held to what the list would accept from them, hidden fields included.
   */
  private async resolveTarget(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    target: BulkTarget,
    constraint: RecordConstraint,
    fields: Awaited<ReturnType<FieldMetadataService['forObject']>>,
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    if (target.kind === 'ids') {
      return { ids: [...new Set(target.ids)], nextCursor: null };
    }

    const { q, conditions } = target.filter;
    assertViewQuery(actor, objectType, fields, { conditions });

    const matched = await searchForList(this.search, tx, actor, objectType, constraint, q);
    const plan = planQuery(
      objectType,
      fields,
      { filters: conditions, matchedIds: matched.matchedIds },
      constraint,
    );

    const descriptor = plan.descriptor;
    const where = [...plan.where];
    if (target.after !== undefined) where.push(sql`${descriptor.id} > ${target.after}::uuid`);

    // One more than the cap, so "is there another batch" needs no count.
    const page = await descriptor.selectPage(tx, {
      tenantId: actor.tenantId,
      where,
      sort: descriptor.id,
      direction: 'asc',
      limit: BULK_MAX_RECORDS + 1,
    });
    const batch = page.slice(0, BULK_MAX_RECORDS).map((row) => String(row['id']));
    const last = batch.at(-1);
    return {
      ids: batch,
      nextCursor: page.length > BULK_MAX_RECORDS && last !== undefined ? last : null,
    };
  }

  /**
   * Run `work` for each record in its own savepoint and sort the outcomes.
   *
   * A domain error is a property of that record or of that attempt (not visible to you, a stale
   * version, a rule the record breaks) and becomes a skip. Anything else is a defect and is
   * rethrown, which rolls back the whole call.
   */
  private async eachRecord(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    ids: readonly string[],
    rows: ReadonlyMap<string, BulkRowRef>,
    work: (sp: Tx, id: string, row: BulkRowRef) => Promise<'changed' | 'no_change'>,
  ): Promise<Outcome> {
    const changedIds: string[] = [];
    const skipped: BulkSkipped[] = [];

    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      try {
        const outcome = await tx.transaction((sp) => work(sp, id, row));
        if (outcome === 'changed') changedIds.push(id);
        else skipped.push({ id, reason: 'no_change' });
      } catch (error) {
        skipped.push(await this.skipFor(tx, actor, objectType, id, row, error));
      }
    }
    return { changedIds, skipped };
  }

  private async skipFor(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    id: string,
    row: BulkRowRef,
    error: unknown,
  ): Promise<BulkSkipped> {
    if (error instanceof VersionConflictError) return { id, reason: 'version_conflict' };
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      return { id, reason: await this.unreachableReason(tx, actor, objectType, row) };
    }
    if (error instanceof DomainError) {
      const message = error.details[0]?.message ?? error.message;
      return { id, reason: 'invalid', message: message.slice(0, 200) };
    }
    throw error;
  }

  /** `not_permitted` for a record the caller can see, `not_found` for one they cannot. */
  private async unreachableReason(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    row: BulkRowRef,
  ): Promise<'not_found' | 'not_permitted'> {
    const readable = can(actor, 'read', {
      objectType,
      record: await recordRefFor(tx, actor, row.ownerId),
    }).allowed;
    return readable ? 'not_permitted' : 'not_found';
  }

  // -------------------------------------------------------------------------

  private async assign(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    ids: readonly string[],
    rows: ReadonlyMap<string, BulkRowRef>,
    toOwnerId: string,
  ): Promise<Outcome> {
    const moved = await this.ownership.reassignInTx(tx, actor, {
      mode: 'records',
      objectType,
      recordIds: [...ids],
      toOwnerId,
    });
    const changedIds = moved.find((item) => item.objectType === objectType)?.movedIds ?? [];
    const movedSet = new Set(changedIds);

    const skipped: BulkSkipped[] = [];
    for (const id of ids) {
      if (movedSet.has(id)) continue;
      const row = rows.get(id);
      if (row === undefined) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      const reason = await this.unreachableReason(tx, actor, objectType, row);
      // Only a record the caller can see may be said to be "already theirs".
      if (reason === 'not_found') skipped.push({ id, reason });
      else if (row.ownerId === toOwnerId) skipped.push({ id, reason: 'no_change' });
      else skipped.push({ id, reason: 'not_permitted' });
    }
    return { changedIds, skipped };
  }

  private async tag(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    ids: readonly string[],
    rows: ReadonlyMap<string, BulkRowRef>,
    action: 'tag_add' | 'tag_remove',
    names: readonly string[],
  ): Promise<Outcome> {
    const port = this.ports[objectType];
    const resolved =
      action === 'tag_add'
        ? await this.findOrCreateTags(tx, actor, names)
        : await findTagsByName(tx, actor.tenantId, names);
    const byLower = new Map(resolved.map((tag) => [tag.name.toLowerCase(), tag]));
    const wanted = [...new Set(names.map((name) => name.toLowerCase()))]
      .map((lower) => byLower.get(lower))
      .filter((tag): tag is TagRef => tag !== undefined);

    return this.eachRecord(tx, actor, objectType, ids, rows, async (sp, id) => {
      // `update` on this very record, judged by the module that owns it. A record outside the
      // caller's reach is `not_found` to them, exactly as on a single edit.
      if (!(await port.allows(sp, actor, 'update', id))) throw new NotFoundError(objectType);

      const changedTagIds =
        action === 'tag_add'
          ? await addRecordTags(sp, {
              tenantId: actor.tenantId,
              userId: actor.userId,
              objectType,
              recordId: id,
              tags: wanted.map((tag) => ({ id: tag.id, rowId: newId() })),
            })
          : await removeRecordTags(sp, {
              tenantId: actor.tenantId,
              objectType,
              recordId: id,
              tagIds: wanted.map((tag) => tag.id),
            });
      if (changedTagIds.length === 0) return 'no_change';

      const changedNames = wanted
        .filter((tag) => changedTagIds.includes(tag.id))
        .map((tag) => tag.name);
      await this.audit.record(sp, actor, {
        action: 'update',
        objectType,
        recordId: id,
        changes: { tags: action === 'tag_add' ? { new: changedNames } : { old: changedNames } },
      });
      await this.outbox.publish(sp, actor, {
        eventType: `${objectType}.updated.v1`,
        objectType,
        recordId: id,
        payload: { changedFields: ['tags'] },
      });
      return 'changed';
    });
  }

  /** Tags by name, creating the ones that do not exist yet, within the workspace's cap. */
  private async findOrCreateTags(
    tx: Tx,
    actor: Actor,
    names: readonly string[],
  ): Promise<TagRef[]> {
    const existing = await findTagsByName(tx, actor.tenantId, names);
    const have = new Set(existing.map((tag) => tag.name.toLowerCase()));
    const missing = names.filter((name) => !have.has(name.toLowerCase()));
    if (missing.length === 0) return existing;

    if ((await countTags(tx, actor.tenantId)) + missing.length > TAGS_MAX_PER_TENANT) {
      throw new ValidationError([
        {
          path: 'tags',
          message: `A workspace can hold up to ${TAGS_MAX_PER_TENANT} tags. Reuse an existing one.`,
        },
      ]);
    }

    const created: TagRef[] = [];
    for (const name of missing) {
      const tag = await insertTag(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        name,
        createdBy: actor.userId,
      });
      created.push(tag);
      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'tag',
        recordId: tag.id,
        changes: { name: { new: tag.name } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'tag.created.v1',
        objectType: 'tag',
        recordId: tag.id,
      });
    }
    return [...existing, ...created];
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
