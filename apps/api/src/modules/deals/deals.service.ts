import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  can,
  canReadField,
  money,
  newId,
  NotFoundError,
  resolveStageState,
  StageRuleViolation,
  ValidationError,
  VersionConflictError,
  zero,
  type Actor,
  type DealStageState,
  type FieldDefinition,
} from '@crm/core';
import {
  parseFilter,
  parseSort,
  toFilterList,
  type DealBoard,
  type DealBoardQuery,
  type DealContactInput,
  type DealCreateInput,
  type DealListQuery,
  type DealUpdateInput,
  type MoneyInput,
} from '@crm/contracts';
import type { Deal as DealRow, Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { assertFiltersReadable, assertSortable } from '../../common/field-queries.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { CurrencyConverter } from '../../platform/exchange-rates/currency-converter.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { PipelinesService, type StageInfo } from '../pipelines/pipelines.service.js';
import { DealsRepository } from './deals.repository.js';
import {
  assertWritableDealFields,
  serializeDeal,
  serializeDeals,
  type DealPerson,
  type SerializedDeal,
} from './deals.serializer.js';
import { allowedSortKeys } from './deals.sql-helpers.js';

/** The largest value a Postgres bigint holds. A larger amount is a 422, not a 500. */
const MAX_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

/**
 * What a stage change drags along with it. When the stage moves these move
 * too, and none of them is a separate edit worth its own `deal.updated` event.
 */
const STAGE_DERIVED_COLUMNS: ReadonlySet<string> = new Set([
  'stageId',
  'pipelineId',
  'probability',
  'closedAt',
  'lostReason',
]);

/**
 * Deals business logic (CLAUDE.md §11.2).
 *
 * The same five steps contacts and accounts follow, in the same order:
 *   1. authorize with `can()` before anything else
 *   2. validate custom fields against this tenant's metadata
 *   3. check field-level write permission
 *   4. do the write, the audit entry and the outbox event in ONE transaction
 *   5. serialize through the field-permission filter on the way out
 *
 * Three things are this module's own:
 *
 * **The stage decides the closed state** (ADR-0020). `closed_at`, `probability`
 * and `lost_reason` are never taken from the client; `resolveStageState` in
 * `@crm/core` derives them from the stage the deal is in, and a trigger in the
 * database restates the same rule. The only way to win a deal through the API
 * is to move it to a won stage.
 *
 * **A move is one event, not two.** A drag changes the stage and, with it,
 * three other columns. That is announced as `deal.stage_changed.v1` — which
 * the timeline renders as "Moved from Qualified to Proposal" — rather than as
 * an `updated` event listing four field names nobody asked to change.
 *
 * **Money** is minor units in a bigint beside its currency (ADR-0011). Board
 * totals are converted into the tenant's currency through `CurrencyConverter`
 * (ADR-0021), never by arithmetic in this file.
 */
@Injectable()
export class DealsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DealsRepository) private readonly repository: DealsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PipelinesService) private readonly pipelines: PipelinesService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(CurrencyConverter) private readonly converter: CurrencyConverter,
  ) {}

  async list(
    actor: Actor,
    query: DealListQuery,
  ): Promise<{ data: SerializedDeal[]; meta: { nextCursor: string | null; hasMore: boolean } }> {
    // Collection-level check. The returned constraint becomes a WHERE clause,
    // so `own` scope never fetches another rep's rows in the first place.
    const decision = assertCan(actor, 'read', { objectType: 'deal' });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'deal');

      const sort = query.sort === undefined ? undefined : parseSort(query.sort);
      if (sort !== undefined) {
        assertSortable(actor, 'deal', sort.field, allowedSortKeys(fields));
      }

      const filters = toFilterList(query.filter).map((raw) => {
        const parsed = parseFilter(raw);
        if (parsed === null) {
          throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
        }
        return parsed;
      });
      assertFiltersReadable(actor, 'deal', filters);

      const result = await this.repository.list(tx, actor.tenantId, {
        constraint: decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
        limit: query.limit,
        cursor: query.cursor,
        sort,
        filters,
        search: query.q,
        fields,
      });

      const people = await this.repository.peopleFor(
        tx,
        actor.tenantId,
        result.rows.map((row) => row.id),
      );

      return {
        data: serializeDeals(actor, result.rows, fields, people),
        meta: { nextCursor: result.nextCursor, hasMore: result.hasMore },
      };
    });
  }

  /**
   * Column totals for the Kanban board, in the tenant's default currency.
   *
   * Computed over every deal the actor's scope admits, not over the cards a
   * page loaded. A caller who may not read `amount` still gets the counts —
   * how many deals sit in a column is not the amount — but no totals: a sum is
   * the amounts, and hiding a field has to hide what can be derived from it.
   */
  async board(actor: Actor, query: DealBoardQuery): Promise<DealBoard> {
    const decision = assertCan(actor, 'read', { objectType: 'deal' });

    return this.inTenant(actor, async (tx) => {
      const pipelineId =
        query.pipelineId ?? (await this.pipelines.defaultPipelineId(tx, actor.tenantId));
      const stages = await this.pipelines.stagesOf(tx, actor.tenantId, pipelineId);
      // A pipeline that is not in this tenant is not found, whatever the reason.
      if (stages === null) throw new NotFoundError('Pipeline');

      const currency = await this.converter.defaultCurrency(tx, actor.tenantId);
      const cells = await this.repository.boardCells(
        tx,
        actor.tenantId,
        pipelineId,
        decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
      );
      const showAmounts = canReadField(actor, 'deal', 'amount');

      const columns: DealBoard['columns'] = [];
      for (const stage of stages) {
        const mine = cells.filter((cell) => cell.stageId === stage.id);
        const count = mine.reduce((total, cell) => total + cell.count, 0);

        if (!showAmounts) {
          columns.push({ stageId: stage.id, count, total: null, unconverted: [] });
          continue;
        }

        const buckets = mine.flatMap((cell) =>
          cell.currency === null || cell.withAmount === 0
            ? []
            : [{ currency: cell.currency, amountMinor: cell.amountMinor, count: cell.withAmount }],
        );
        const converted = await this.converter.totalIn(tx, actor.tenantId, currency, buckets);
        const total = converted.total ?? zero(currency);

        columns.push({
          stageId: stage.id,
          count,
          total: { amountMinor: total.amountMinor.toString(), currency: total.currency },
          unconverted: converted.unconverted.map((bucket) => ({
            currency: bucket.currency,
            count: bucket.count,
            amountMinor: bucket.amountMinor.toString(),
          })),
        });
      }

      return { pipelineId, currency, columns };
    });
  }

  async getById(actor: Actor, id: string): Promise<SerializedDeal> {
    assertCan(actor, 'read', { objectType: 'deal' });

    return this.inTenant(actor, async (tx) => {
      const row = await this.loadOrNotFound(tx, actor, id);
      // Record-level check. Out of scope raises 404, not 403, so the endpoint
      // cannot be used to discover that an id exists (CLAUDE.md §5.5).
      assertCan(actor, 'read', { objectType: 'deal', record: { ownerId: row.ownerId } });

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'deal');
      const people = await this.repository.peopleFor(tx, actor.tenantId, [row.id]);
      return serializeDeal(actor, row, fields, people.get(row.id) ?? []);
    });
  }

  async create(actor: Actor, input: DealCreateInput): Promise<SerializedDeal> {
    return this.inTenant(actor, (tx) => this.createInTx(actor, tx, input));
  }

  /**
   * Create a deal inside a transaction somebody else owns.
   *
   * Lead conversion creates several records and must be all-or-nothing, so it
   * needs the very same checks, audit entry and outbox event `create` performs,
   * without opening a second transaction. Every guarantee `create` gives holds
   * here too: it is the same code, not a copy of it.
   */
  async createInTx(actor: Actor, tx: Tx, input: DealCreateInput): Promise<SerializedDeal> {
    assertCan(actor, 'create', { objectType: 'deal' });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'deal');
    assertWritableDealFields(actor, input, fields);

    const customFields = this.validateCustomFields(input.customFields ?? {}, fields, false);
    const ownerId = this.resolveOwner(actor, input.ownerId ?? undefined);
    const amount = toAmountColumns(input.amount ?? null);

    await this.assertLinks(tx, actor, input.accountId, input.primaryContactId, input.contacts);

    const stage = await this.placementForCreate(tx, actor, input.pipelineId, input.stageId);
    const state = this.stageState(stage, undefined, input.probability, input.lostReason);

    const id = newId();
    const row = await this.translateStageState(() =>
      this.repository.insert(tx, {
        id,
        tenantId: actor.tenantId,
        ownerId,
        name: input.name,
        accountId: input.accountId ?? null,
        primaryContactId: input.primaryContactId ?? null,
        pipelineId: stage.pipelineId,
        stageId: stage.id,
        ...amount,
        ...state,
        expectedCloseDate: input.expectedCloseDate ?? null,
        customFields,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      }),
    );

    const people = await this.writePeople(tx, actor, row.id, input.contacts);

    // Same transaction as the insert: the audit entry and the event exist if
    // and only if the deal does (CLAUDE.md §5.10, ADR-0006).
    await this.audit.record(tx, actor, {
      action: 'create',
      objectType: 'deal',
      recordId: row.id,
      changes: diffChanges(
        {},
        {
          name: row.name,
          stageId: row.stageId,
          pipelineId: row.pipelineId,
          amountMinor: row.amountMinor,
          currency: row.currency,
          ownerId: row.ownerId,
        },
      ),
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'deal.created.v1',
      objectType: 'deal',
      recordId: row.id,
      payload: {
        ownerId: row.ownerId,
        pipelineId: row.pipelineId,
        stageId: row.stageId,
        stageName: stage.name,
      },
    });

    return serializeDeal(actor, row, fields, people);
  }

  async update(actor: Actor, id: string, input: DealUpdateInput): Promise<SerializedDeal> {
    assertCan(actor, 'update', { objectType: 'deal' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', { objectType: 'deal', record: { ownerId: existing.ownerId } });

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'deal');
      assertWritableDealFields(actor, input, fields);

      await this.assertLinks(tx, actor, input.accountId, input.primaryContactId, input.contacts);

      const stage = await this.placementForUpdate(tx, actor, existing, input);
      const state = this.stageState(stage, existing, input.probability, input.lostReason);

      const patch = this.buildPatch(actor, input, existing, fields);

      const updated = await this.translateStageState(() =>
        this.repository.updateWithVersion(tx, actor.tenantId, id, input.version, {
          ...patch,
          pipelineId: stage.pipelineId,
          stageId: stage.id,
          ...state,
          updatedBy: actor.userId,
        }),
      );

      if (updated === null) {
        // The row exists — we just loaded it — so a zero-row update means the
        // version moved: somebody else saved first. 409, never a silent clobber.
        throw new VersionConflictError('deal');
      }

      const before = await this.repository.peopleFor(tx, actor.tenantId, [id]);
      const previousPeople = before.get(id) ?? [];
      const people =
        input.contacts === undefined
          ? previousPeople
          : await this.writePeople(tx, actor, id, input.contacts);

      const changes = diffChanges(existing, updated);
      if (input.contacts !== undefined && !samePeople(previousPeople, people)) {
        changes['contacts'] = { old: previousPeople, new: people };
      }

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'deal',
        recordId: id,
        changes,
      });

      const stageChanged = existing.stageId !== updated.stageId;
      if (stageChanged) {
        const from = await this.pipelines.findStage(tx, actor.tenantId, existing.stageId);
        await this.outbox.publish(tx, actor, {
          eventType: 'deal.stage_changed.v1',
          objectType: 'deal',
          recordId: id,
          payload: {
            pipelineId: updated.pipelineId,
            fromStageId: existing.stageId,
            fromStageName: from?.name ?? null,
            toStageId: stage.id,
            toStageName: stage.name,
            stageType: stage.stageType,
          },
        });
      }

      const otherChanges = Object.keys(changes).filter(
        (key) => !stageChanged || !STAGE_DERIVED_COLUMNS.has(key),
      );
      if (otherChanges.length > 0) {
        await this.outbox.publish(tx, actor, {
          eventType: 'deal.updated.v1',
          objectType: 'deal',
          recordId: id,
          payload: { changedFields: otherChanges },
        });
      }

      return serializeDeal(actor, updated, fields, people);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'deal' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'delete', { objectType: 'deal', record: { ownerId: existing.ownerId } });

      const deleted = await this.repository.softDelete(
        tx,
        actor.tenantId,
        id,
        actor.userId,
        version,
      );
      if (deleted === null) throw new VersionConflictError('deal');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'deal',
        recordId: id,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'deal.deleted.v1',
        objectType: 'deal',
        recordId: id,
      });
    });
  }

  /**
   * What to call these deals, for the ones this actor may read (ADR-0005).
   *
   * See `ContactsService.linkLabels`: record scope in SQL, label built only
   * from readable fields, absent rather than refused when either says no.
   */
  async linkLabels(tx: Tx, actor: Actor, ids: readonly string[]): Promise<Map<string, string>> {
    const decision = can(actor, 'read', { objectType: 'deal' });
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
        canReadField(actor, 'deal', 'name') && row.name.length > 0 ? row.name : 'Deal',
      ]),
    );
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }

  /**
   * Load a record or raise 404.
   *
   * RLS has already excluded other tenants, so "not found" covers both a
   * genuinely missing record and one belonging to someone else —
   * indistinguishable from outside, which is the point (CLAUDE.md §5.5).
   */
  private async loadOrNotFound(tx: Tx, actor: Actor, id: string): Promise<DealRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row === null) throw new NotFoundError('Deal');
    return row;
  }

  /**
   * Where a new deal goes.
   *
   * A named stage decides the pipeline, and a named pipeline must agree with
   * it. With neither named, the deal starts in the first open stage of the
   * tenant's default pipeline.
   *
   * Every refusal says the same thing whether the id belongs to another
   * tenant or to nothing at all, for the reason `getById` returns 404 for
   * both: a stage id is otherwise an existence oracle for other companies'
   * configuration.
   */
  private async placementForCreate(
    tx: Tx,
    actor: Actor,
    pipelineId: string | undefined,
    stageId: string | undefined,
  ): Promise<StageInfo> {
    if (stageId !== undefined) {
      const stage = await this.pipelines.findStage(tx, actor.tenantId, stageId);
      if (stage === null || (pipelineId !== undefined && stage.pipelineId !== pipelineId)) {
        throw stageNotInPipeline();
      }
      await this.assertPipelineUsable(tx, actor, stage.pipelineId);
      return stage;
    }

    const resolvedPipelineId =
      pipelineId ?? (await this.pipelines.defaultPipelineId(tx, actor.tenantId));
    await this.assertPipelineUsable(tx, actor, resolvedPipelineId);

    const first = await this.pipelines.firstOpenStage(tx, actor.tenantId, resolvedPipelineId);
    if (first === null) {
      throw new ValidationError([
        { path: 'pipelineId', message: 'That pipeline has no open stage to start a deal in' },
      ]);
    }
    return first;
  }

  /**
   * Where an edited deal ends up.
   *
   * The pipeline changes only when the caller says so, and then the stage has
   * to be one of the new pipeline's. A stage from another pipeline named
   * without the pipeline is refused rather than silently moving the deal
   * between pipelines — that is a bigger edit than a drag and should be asked
   * for by name.
   */
  private async placementForUpdate(
    tx: Tx,
    actor: Actor,
    existing: DealRow,
    input: DealUpdateInput,
  ): Promise<StageInfo> {
    const targetPipelineId = input.pipelineId ?? existing.pipelineId;
    const targetStageId = input.stageId ?? existing.stageId;

    const stage = await this.pipelines.findStage(tx, actor.tenantId, targetStageId);
    if (stage === null || stage.pipelineId !== targetPipelineId) {
      throw stageNotInPipeline();
    }
    if (targetPipelineId !== existing.pipelineId) {
      await this.assertPipelineUsable(tx, actor, targetPipelineId);
    }
    return stage;
  }

  private async assertPipelineUsable(tx: Tx, actor: Actor, pipelineId: string): Promise<void> {
    if (!(await this.pipelines.pipelineIsUsable(tx, actor.tenantId, pipelineId))) {
      throw new ValidationError([{ path: 'pipelineId', message: 'That pipeline does not exist' }]);
    }
  }

  /** The stage rules, with a refusal turned into a 422 on the field to fix. */
  private stageState(
    stage: StageInfo,
    previous: DealRow | undefined,
    probability: number | undefined,
    lostReason: string | null | undefined,
  ): DealStageState {
    try {
      return resolveStageState({
        stage,
        previous:
          previous === undefined
            ? undefined
            : {
                stageId: previous.stageId,
                probability: previous.probability,
                closedAt: previous.closedAt,
                lostReason: previous.lostReason,
              },
        probability,
        lostReason,
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof StageRuleViolation) {
        throw new ValidationError([{ path: error.path, message: error.message }]);
      }
      throw error;
    }
  }

  /**
   * Turn the database's closed-state refusal into the module's own error.
   *
   * `resolveStageState` produces a state that satisfies the trigger, so this
   * should be unreachable. It is here for the day a rule is changed in one
   * place and not the other: a caller would rather receive a 422 naming the
   * stage than a 500.
   */
  private async translateStageState<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isConstraintViolation(error, 'deals_stage_state')) {
        throw new ValidationError([
          { path: 'stageId', message: 'This deal cannot be in that stage in its current state' },
        ]);
      }
      throw error;
    }
  }

  /**
   * Do the account and the people named on a deal exist in this workspace?
   *
   * Checked through the owning modules' services, not their tables (ADR-0001),
   * and scoped to the tenant rather than to the actor's record scope: a rep
   * with `own` scope must be able to put their deal under an account a
   * colleague owns, and attaching the id reveals nothing — reading the account
   * still goes through its own `getById`. The same message covers another
   * tenant's id and a missing one.
   */
  private async assertLinks(
    tx: Tx,
    actor: Actor,
    accountId: string | null | undefined,
    primaryContactId: string | null | undefined,
    people: readonly DealContactInput[] | undefined,
  ): Promise<void> {
    if (accountId != null) {
      if (!(await this.accounts.existsForLinking(tx, actor.tenantId, accountId))) {
        throw new ValidationError([{ path: 'accountId', message: 'That account does not exist' }]);
      }
    }

    if (people !== undefined) {
      const ids = people.map((person) => person.contactId);
      if (new Set(ids).size !== ids.length) {
        throw new ValidationError([
          { path: 'contacts', message: 'A person can be on a deal only once' },
        ]);
      }
    }

    const wanted = [
      ...(primaryContactId == null ? [] : [primaryContactId]),
      ...(people ?? []).map((person) => person.contactId),
    ];
    if (wanted.length === 0) return;

    const found = await this.contacts.existingIdsForLinking(tx, actor.tenantId, wanted);
    if (primaryContactId != null && !found.has(primaryContactId)) {
      throw new ValidationError([
        { path: 'primaryContactId', message: 'That contact does not exist' },
      ]);
    }
    if ((people ?? []).some((person) => !found.has(person.contactId))) {
      throw new ValidationError([
        { path: 'contacts', message: 'One or more of those contacts do not exist' },
      ]);
    }
  }

  private async writePeople(
    tx: Tx,
    actor: Actor,
    dealId: string,
    people: readonly DealContactInput[] | undefined,
  ): Promise<DealPerson[]> {
    if (people === undefined || people.length === 0) {
      if (people !== undefined) {
        await this.repository.replacePeople(tx, actor.tenantId, dealId, [], actor.userId);
      }
      return [];
    }

    await this.repository.replacePeople(
      tx,
      actor.tenantId,
      dealId,
      people.map((person) => ({
        id: newId(),
        contactId: person.contactId,
        role: person.role ?? null,
      })),
      actor.userId,
    );
    return people.map((person) => ({ contactId: person.contactId, role: person.role ?? null }));
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
    const decision = can(actor, 'update', { objectType: 'deal' });
    if (!decision.allowed || decision.scope !== 'all') {
      throw new ValidationError([
        { path: 'ownerId', message: 'You cannot assign records to another user' },
      ]);
    }
    return requestedOwnerId;
  }

  /**
   * The columns an edit changes, other than the ones the stage decides.
   * Placement and the derived closed state are added by `update`.
   */
  private buildPatch(
    actor: Actor,
    input: DealUpdateInput,
    existing: DealRow,
    fields: readonly FieldDefinition[],
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    for (const key of ['name', 'accountId', 'primaryContactId', 'expectedCloseDate'] as const) {
      if (key in input) patch[key] = input[key] ?? null;
    }

    // The two amount columns move together or not at all, so that a PATCH can
    // never leave an amount without its currency.
    if ('amount' in input) {
      Object.assign(patch, toAmountColumns(input.amount ?? null));
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

function stageNotInPipeline(): ValidationError {
  return new ValidationError([
    { path: 'stageId', message: 'That stage does not exist in this pipeline' },
  ]);
}

function samePeople(a: readonly DealPerson[], b: readonly DealPerson[]): boolean {
  const key = (person: DealPerson) => `${person.contactId}:${person.role ?? ''}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The wire shape of money, as the two columns that store it.
 *
 * `money()` from @crm/core is what rejects an invented currency code. The
 * bound is checked here too: the schema allows nineteen digits, and the
 * largest nineteen-digit number is more than a bigint holds, which would
 * otherwise arrive as a driver error and a 500.
 */
function toAmountColumns(input: MoneyInput | null): {
  amountMinor: bigint | null;
  currency: string | null;
} {
  if (input === null) return { amountMinor: null, currency: null };

  try {
    const amount = money(BigInt(input.amountMinor), input.currency);
    if (amount.amountMinor > MAX_AMOUNT_MINOR) throw new RangeError('Too large');
    return { amountMinor: amount.amountMinor, currency: amount.currency };
  } catch {
    throw new ValidationError([
      {
        path: 'amount',
        message: 'Must be a valid amount in whole minor units and an ISO-4217 code',
      },
    ]);
  }
}
