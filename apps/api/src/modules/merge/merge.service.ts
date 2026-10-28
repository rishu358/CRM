import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  canReadField,
  canWriteField,
  can,
  diffChanges,
  FieldNotWritableError,
  ForbiddenError,
  MERGE_FIELDS,
  MERGE_MAX_MOVED_ROWS,
  MergeBlockedError,
  MergeTooLargeError,
  newId,
  NotFoundError,
  RecordAlreadyMergedError,
  ValidationError,
  VersionConflictError,
  type Action,
  type Actor,
  type FieldDefinition,
  type MergeableObjectType,
  type RecordConstraint,
} from '@crm/core';
import {
  accountUpdateSchema,
  contactUpdateSchema,
  type AccountUpdateInput,
  type ContactUpdateInput,
  type MergeRequestInput,
  type MergeResult,
} from '@crm/contracts';
import {
  countMergeWork,
  countVisibleMerge,
  findMergePointer,
  finishMaster,
  hasOpenErasure,
  isAccountDescendantOf,
  lockMergePair,
  moveMergeChildren,
  writeMergePointer,
  type MergeScopes,
  type MoveResult,
  type Tx,
  type VisibleMergeCounts,
} from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, type AuditEntry } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { IdempotencyService } from '../../platform/idempotency.service.js';
import { OutboxService, type DomainEvent } from '../../platform/outbox.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { ContactsService } from '../contacts/contacts.service.js';

/** What the merge needs from the module that owns the record. Each is that module's own service method. */
interface MergePort {
  get(actor: Actor, tx: Tx, id: string): Promise<Readonly<Record<string, unknown>>>;
  update(actor: Actor, tx: Tx, id: string, input: Record<string, unknown>): Promise<unknown>;
  remove(actor: Actor, tx: Tx, id: string, version: number): Promise<void>;
  allows(tx: Tx, actor: Actor, action: Action, id: string): Promise<boolean>;
}

/** Thrown to unwind a dry run's transaction; carries the answer out of it. */
class RolledBack extends Error {
  constructor(readonly result: MergeResult) {
    super('dry run rolled back');
  }
}

/** The fields that are not data of the record: never part of an audit "before and after". */
const NOT_DATA = new Set(['id', 'version', 'createdAt', 'updatedAt', 'tags']);

/**
 * Merge two contacts or two accounts (MVP_SPEC M4, ADR-0064).
 *
 * ## What it does
 *
 * One transaction folds the loser into the master: it takes the field values the person chose, receives
 * everything that pointed at the loser, and the loser goes to the Recycle Bin with a pointer to the
 * master. The merged record is validated as an edit would be; the loser can be restored by an
 * administrator (what that restores is in ADR-0064).
 *
 * ## Why it can be trusted
 *
 * It does almost none of the work itself, so it cannot do what a single edit or delete could not:
 *
 *   - the master is changed through its own module's `updateInTx` and the loser removed through its
 *     `removeInTx`: `can()` at the actor's scope on each record, field-level write permission, the
 *     version guard, validation, an audit entry and an outbox event each. The search index and the
 *     timeline already react to those events.
 *   - every other table is touched by `@crm/db`'s closed catalogue of statements (modules may not read
 *     each other's tables), counted first against a cap and moved in this same transaction.
 *   - a field the actor cannot read or cannot write can never be chosen, and is answered exactly like a
 *     field that does not exist. The master keeps what it has there.
 *   - both records are locked in id order, so two merges of the same pair, in either direction, queue up
 *     instead of deadlocking; the second finds the first's work done and is told so.
 *
 * ## Retries and previews
 *
 * With an `Idempotency-Key` the first answer is remembered (ids and counts only, never a field's value)
 * and a retry re-reads the master as it is now. A dry run executes everything, every refusal included,
 * and rolls back: the preview cannot differ from the merge.
 */
@Injectable()
export class MergeService {
  private readonly ports: Readonly<Record<MergeableObjectType, MergePort>>;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ContactsService) contacts: ContactsService,
    @Inject(AccountsService) accounts: AccountsService,
  ) {
    // The `as` casts are the one place an update input is typed by object. The input was parsed by that
    // object's own update schema in `buildPatch`, so it is what the service expects.
    this.ports = {
      contact: {
        get: (a, tx, id) => contacts.getByIdInTx(a, tx, id),
        update: (a, tx, id, i) => contacts.updateInTx(a, tx, id, i as ContactUpdateInput),
        remove: (a, tx, id, v) => contacts.removeInTx(a, tx, id, v),
        allows: (tx, a, action, id) => contacts.allowsRecordAction(tx, a, action, id),
      },
      account: {
        get: (a, tx, id) => accounts.getByIdInTx(a, tx, id),
        update: (a, tx, id, i) => accounts.updateInTx(a, tx, id, i as AccountUpdateInput),
        remove: (a, tx, id, v) => accounts.removeInTx(a, tx, id, v),
        allows: (tx, a, action, id) => accounts.allowsRecordAction(tx, a, action, id),
      },
    };
  }

  async merge(
    actor: Actor,
    input: MergeRequestInput,
    idempotencyKey: string | undefined,
  ): Promise<MergeResult> {
    const { objectType } = input;
    // The coarse checks first, before anything the caller named is looked at.
    assertCan(actor, 'update', { objectType });
    assertCan(actor, 'delete', { objectType });

    if (input.masterId === input.loserId) {
      throw new ValidationError([
        { path: 'loserId', message: 'A record cannot be merged with itself' },
      ]);
    }

    try {
      return await this.inTenant(actor, async (tx) => {
        if (input.dryRun) throw new RolledBack(await this.execute(tx, actor, input));

        return this.idempotency.once<MergeResult>(
          tx,
          actor,
          idempotencyKey,
          { objectType, action: 'merge' },
          // A dry run is never stored, so it is not part of what makes two requests the same.
          { ...input, dryRun: false },
          async () => {
            const result = await this.execute(tx, actor, input);
            return {
              answer: result,
              reference: {
                recordId: result.masterId,
                loserId: result.loserId,
                counts: result.counts,
                fromLoser: result.fromLoser,
              },
            };
          },
          async (reference) => {
            const record = await this.ports[objectType].get(actor, tx, reference.recordId);
            return {
              objectType,
              masterId: reference.recordId,
              loserId: String(reference['loserId']),
              dryRun: false,
              counts: reference['counts'] as VisibleMergeCounts,
              fromLoser: reference['fromLoser'] as string[],
              record,
              replayed: true,
            };
          },
        );
      });
    } catch (error) {
      if (error instanceof RolledBack) return error.result;
      throw error;
    }
  }

  // -------------------------------------------------------------------------

  private async execute(tx: Tx, actor: Actor, input: MergeRequestInput): Promise<MergeResult> {
    const { objectType, masterId, loserId } = input;
    const port = this.ports[objectType];

    // ---- both records, locked, found, visible, versioned -------------------------------------------
    const rows = await lockMergePair(tx, actor.tenantId, objectType, [masterId, loserId]);
    const master = rows.get(masterId);
    const loser = rows.get(loserId);

    if (master === undefined || master.deletedAt !== null) throw new NotFoundError(objectType);
    // Out of the caller's reach is "not found" on either record, as on a read.
    if (!(await port.allows(tx, actor, 'read', masterId))) throw new NotFoundError(objectType);

    if (loser === undefined) throw new NotFoundError(objectType);
    if (loser.deletedAt !== null) {
      // The same pair merged a moment ago (a concurrent request, or a retry with a new key): that is
      // not a failure of the request, so it is said as such. Only said to somebody who can read the
      // master they named, which was checked above.
      const pointer = await findMergePointer(tx, actor.tenantId, objectType, loserId);
      if (pointer?.masterId === masterId) throw new RecordAlreadyMergedError();
      throw new NotFoundError(objectType);
    }
    if (!(await port.allows(tx, actor, 'read', loserId))) throw new NotFoundError(objectType);

    // Visible but not changeable is a refusal they can be told about.
    if (!(await port.allows(tx, actor, 'update', masterId))) {
      throw new ForbiddenError();
    }
    if (!(await port.allows(tx, actor, 'delete', loserId))) throw new ForbiddenError();

    if (master.version !== input.masterVersion || loser.version !== input.loserVersion) {
      throw new VersionConflictError(objectType);
    }

    // ---- rules of the pair --------------------------------------------------------------------------
    if (
      (await hasOpenErasure(tx, actor.tenantId, objectType, masterId)) ||
      (await hasOpenErasure(tx, actor.tenantId, objectType, loserId))
    ) {
      throw new MergeBlockedError(
        'A request to erase one of these contacts is open. Finish or cancel it before merging.',
      );
    }
    if (
      objectType === 'account' &&
      (await isAccountDescendantOf(tx, actor.tenantId, masterId, loserId))
    ) {
      throw new MergeBlockedError(
        'The account you are keeping sits under the one you are merging away. Move one out of the other’s hierarchy first.',
      );
    }

    // ---- what the person chose ----------------------------------------------------------------------
    const definitions = await this.fieldMetadata.forObject(tx, actor.tenantId, objectType);
    const choices = this.resolveChoices(actor, objectType, definitions, input.fields);
    const masterBefore = await port.get(actor, tx, masterId);
    const loserView = await port.get(actor, tx, loserId);
    const patch = this.buildPatch(objectType, choices, loserView);

    // ---- the work, counted before any of it is done -------------------------------------------------
    const work = await countMergeWork(tx, actor.tenantId, objectType, loserId);
    if (work.totalRows > MERGE_MAX_MOVED_ROWS) {
      throw new MergeTooLargeError(work.totalRows, MERGE_MAX_MOVED_ROWS);
    }
    const counts = await countVisibleMerge(
      tx,
      actor.tenantId,
      objectType,
      loserId,
      masterId,
      this.scopesFor(actor),
    );

    // ---- do it --------------------------------------------------------------------------------------
    // The pointer first: a converted lead's links may only be moved, by the database's own rule, in a
    // transaction that has already said which record was merged into which.
    await writeMergePointer(tx, {
      id: newId(),
      tenantId: actor.tenantId,
      userId: actor.userId,
      objectType,
      loserId,
      masterId,
      moved: { rows: work.totalRows },
    });

    const changesFields = Object.keys(patch).length > 0;
    if (changesFields) {
      // Validated as an edit is: the merged value of an e-mail, a phone or a custom field must pass the
      // same rules, and a 422 here is the clear answer, never a 500 from deeper in.
      const parsed = this.parsePatch(objectType, { ...patch, version: master.version });
      await port.update(actor, tx, masterId, parsed);
    }

    const move = await moveMergeChildren(tx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      objectType,
      loserId,
      masterId,
    });
    await finishMaster(tx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      objectType,
      loserId,
      masterId,
      touch: !changesFields,
    });

    // `loserVersion` is the loser's own: nothing above wrote to it.
    await port.remove(actor, tx, loserId, input.loserVersion);

    const masterAfter = await port.get(actor, tx, masterId);
    await this.record(tx, actor, input, move, masterBefore, masterAfter, loserView, choices);

    return {
      objectType,
      masterId,
      loserId,
      dryRun: input.dryRun,
      counts,
      fromLoser: choices.map((choice) => choice.apiKey),
      record: masterAfter,
      replayed: false,
    };
  }

  /**
   * The fields the person named, each checked against what they may do, as a hidden field would be:
   * the answer for a field that does not exist, is not active, or is one the caller cannot both read and
   * write is the same one, so naming fields cannot be used to find out which are concealed.
   */
  private resolveChoices(
    actor: Actor,
    objectType: MergeableObjectType,
    definitions: readonly FieldDefinition[],
    requested: Readonly<Record<string, 'master' | 'loser'>>,
  ): { apiKey: string; custom: boolean; choice: 'master' | 'loser' }[] {
    const standard = new Map(MERGE_FIELDS[objectType].map((f) => [f.apiKey, f.fieldKey]));
    const custom = new Set(
      definitions.filter((d) => d.isActive && !d.isSystem).map((definition) => definition.key),
    );

    const refused: string[] = [];
    const choices: { apiKey: string; custom: boolean; choice: 'master' | 'loser' }[] = [];
    for (const [key, choice] of Object.entries(requested)) {
      const standardKey = standard.get(key);
      const isCustom = standardKey === undefined && custom.has(key);
      const fieldKey = standardKey ?? (isCustom ? key : undefined);
      if (
        fieldKey === undefined ||
        !canReadField(actor, objectType, fieldKey) ||
        !canWriteField(actor, objectType, fieldKey)
      ) {
        refused.push(key);
        continue;
      }
      // "master" is the default, so naming it changes nothing; it is only allowed where "loser" would be.
      if (choice === 'loser') choices.push({ apiKey: key, custom: isCustom, choice });
    }
    if (refused.length > 0) throw new FieldNotWritableError(refused);
    return choices;
  }

  /** The update input that gives the master the loser's value for each field chosen. */
  private buildPatch(
    objectType: MergeableObjectType,
    choices: readonly { apiKey: string; custom: boolean }[],
    loserView: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    void objectType;
    const patch: Record<string, unknown> = {};
    const customFields: Record<string, unknown> = {};
    const loserCustom = (loserView['customFields'] ?? {}) as Record<string, unknown>;
    for (const choice of choices) {
      if (choice.custom) customFields[choice.apiKey] = loserCustom[choice.apiKey] ?? null;
      else patch[choice.apiKey] = loserView[choice.apiKey] ?? null;
    }
    if (Object.keys(customFields).length > 0) patch['customFields'] = customFields;
    return patch;
  }

  private parsePatch(
    objectType: MergeableObjectType,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = objectType === 'contact' ? contactUpdateSchema : accountUpdateSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }

  /** The caller's read scope per kind of linked record, for the counts they are shown. */
  private scopesFor(actor: Actor): MergeScopes {
    const scope = (
      objectType: 'activity' | 'deal' | 'contact' | 'account' | 'lead',
    ): RecordConstraint | null => {
      const decision = can(actor, 'read', { objectType });
      return decision.allowed ? decision.constraint : null;
    };
    return {
      activity: scope('activity'),
      deal: scope('deal'),
      contact: scope('contact'),
      account: scope('account'),
      lead: scope('lead'),
    };
  }

  /** The audit entries and events that say what the merge did, beside the ones the edit and delete wrote. */
  private async record(
    tx: Tx,
    actor: Actor,
    input: MergeRequestInput,
    move: MoveResult,
    masterBefore: Readonly<Record<string, unknown>>,
    masterAfter: Readonly<Record<string, unknown>>,
    loserView: Readonly<Record<string, unknown>>,
    choices: readonly { apiKey: string }[],
  ): Promise<void> {
    const { objectType, masterId, loserId } = input;
    const data = (view: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(Object.entries(view).filter(([key]) => !NOT_DATA.has(key)));

    // Before and after of both records, as the person who merged them could read them.
    const masterChanges = diffChanges(data(masterBefore), data(masterAfter));
    const loserChanges = diffChanges(
      data(loserView),
      Object.fromEntries(Object.keys(data(loserView)).map((key) => [key, null])),
    );
    const entries: AuditEntry[] = [
      {
        action: 'merge',
        objectType,
        recordId: masterId,
        changes: {
          ...masterChanges,
          mergedFrom: { new: loserId },
          moved: { new: move.moved },
        },
      },
      {
        action: 'merge',
        objectType,
        recordId: loserId,
        changes: { ...loserChanges, mergedInto: { new: masterId } },
      },
    ];
    const events: DomainEvent[] = [
      {
        eventType: `${objectType}.merged.v1`,
        objectType,
        recordId: masterId,
        payload: {
          masterId,
          loserId,
          moved: move.moved,
          fromLoser: choices.map((choice) => choice.apiKey),
        },
      },
    ];

    // Every record that now points at the master has changed, so it is audited and announced like any edit.
    const via: Record<string, readonly { field: string; ids: readonly string[]; type: string }[]> =
      {
        contact: [
          { field: 'primaryContactId', ids: move.repointed.deal, type: 'deal' },
          { field: 'convertedContactId', ids: move.repointed.lead, type: 'lead' },
        ],
        account: [
          { field: 'accountId', ids: move.repointed.contact, type: 'contact' },
          { field: 'accountId', ids: move.repointed.deal, type: 'deal' },
          { field: 'parentAccountId', ids: move.repointed.account, type: 'account' },
          { field: 'convertedAccountId', ids: move.repointed.lead, type: 'lead' },
        ],
      };
    for (const group of via[objectType] ?? []) {
      for (const id of group.ids) {
        entries.push({
          action: 'update',
          objectType: group.type,
          recordId: id,
          changes: { [group.field]: { old: loserId, new: masterId } },
        });
        events.push({
          eventType: `${group.type}.updated.v1`,
          objectType: group.type,
          recordId: id,
          payload: { changedFields: [group.field], viaMerge: masterId },
        });
      }
    }

    await this.audit.recordMany(tx, actor, entries);
    await this.outbox.publishMany(tx, actor, events);
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
