import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  can,
  canReadField,
  isSchedulable,
  newId,
  NotFoundError,
  reminderInstantFor,
  ValidationError,
  VersionConflictError,
  type Action,
  type Actor,
  type ActivityType,
  type FieldDefinition,
  type RecordConstraint,
  type LinkTargetType,
} from '@crm/core';
import { sanitizeRichText } from '@crm/core/html';
import {
  parseFilter,
  parseSort,
  toFilterList,
  type ActivityCreateInput,
  type ActivityLinkInput,
  type ActivityLinkView,
  type ActivityListQuery,
  type ActivityUpdateInput,
} from '@crm/contracts';
import { recordRefFor, type Activity as ActivityRow, type Tx } from '@crm/db';
import { assertFiltersReadable, assertSortable } from '../../common/field-queries.js';
import { searchForList } from '../../common/record-search.js';
import { SEARCH_PROVIDER, type ApiSearchProvider } from '../../platform/search/search.tokens.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { IdempotencyService } from '../../platform/idempotency.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { ActivitiesRepository } from './activities.repository.js';
import {
  assertWritableActivityFields,
  serializeActivities,
  serializeActivity,
  type SerializedActivity,
} from './activities.serializer.js';
import { allowedSortKeys } from './activities.sql-helpers.js';
import { keyFor, RecordLinksService } from './record-links.service.js';

/**
 * Activities business logic (MVP_SPEC §M6).
 *
 * The shape is the one the contacts module set (CLAUDE.md §11.2):
 *   1. authorize with `can()` before anything else
 *   2. validate custom fields against this tenant's metadata
 *   3. check field-level write permission
 *   4. do the write, the audit entry and the outbox events in ONE transaction
 *   5. serialize through the field-permission filter on the way out
 *
 * Two things are specific to this module and are the parts worth reading
 * carefully:
 *
 *   - **Ownership is `assigned_to`** (ADR-0026). There is no `owner_id`, so
 *     every scope decision — list, read, update, My Day — is about who the
 *     work belongs to.
 *   - **Links are checked, both ways** (ADR-0005). Creating one requires the
 *     caller to be able to read the target; reading one only shows targets
 *     they can read. Without both, the link table would be a way around
 *     record scope.
 */
@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ActivitiesRepository) private readonly repository: ActivitiesRepository,
    @Inject(RecordLinksService) private readonly recordLinks: RecordLinksService,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(SEARCH_PROVIDER) private readonly search: ApiSearchProvider,
  ) {}

  async list(
    actor: Actor,
    query: ActivityListQuery,
  ): Promise<{
    data: SerializedActivity[];
    meta: { nextCursor: string | null; hasMore: boolean; truncated?: boolean };
  }> {
    const decision = assertCan(actor, 'read', { objectType: 'activity' });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');

      const sort = query.sort === undefined ? undefined : parseSort(query.sort);
      if (sort !== undefined) {
        assertSortable(actor, 'activity', sort.field, allowedSortKeys(fields));
      }

      const filters = toFilterList(query.filter).map((raw) => {
        const parsed = parseFilter(raw);
        if (parsed === null) {
          throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
        }
        return parsed;
      });
      assertFiltersReadable(actor, 'activity', filters);

      // "The activities on this record" is only answerable if the caller can
      // see the record. A 404 rather than an empty list: an empty list for a
      // record in another tenant and an empty list for a record with no
      // activities would be the same answer, and the difference is exactly
      // what an attacker is probing for.
      let linkedTo: { objectType: LinkTargetType; recordId: string } | undefined;
      if (query.objectType !== undefined && query.recordId !== undefined) {
        const target = await this.recordLinks.resolve(tx, actor, query.objectType, query.recordId);
        if (target === null) throw new NotFoundError(query.objectType);
        linkedTo = { objectType: query.objectType, recordId: query.recordId };
      }

      const constraint: RecordConstraint = decision.allowed
        ? decision.constraint
        : { kind: 'own', userId: actor.userId };
      const matched = await searchForList(this.search, tx, actor, 'activity', constraint, query.q);

      const result = await this.repository.list(tx, actor.tenantId, {
        constraint,
        limit: query.limit,
        cursor: query.cursor,
        sort,
        filters,
        matchedIds: matched.matchedIds,
        fields,
        linkedTo,
        status: query.status,
        assignedTo: query.assignedTo,
      });

      const links = await this.resolveLinks(tx, actor, result.rows);

      return {
        data: serializeActivities(actor, result.rows, fields, links),
        meta: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          ...(matched.truncated ? { truncated: true } : {}),
        },
      };
    });
  }

  async getById(actor: Actor, id: string): Promise<SerializedActivity> {
    return this.inTenant(actor, (tx) => this.getByIdInTx(actor, tx, id));
  }

  /**
   * Read one activity inside a transaction somebody else owns, exactly as `getById` does: same
   * permission checks, same 404 for what is out of scope, same serializer. A replayed
   * `Idempotency-Key` re-reads the record it created through this (ADR-0060).
   */
  async getByIdInTx(actor: Actor, tx: Tx, id: string): Promise<SerializedActivity> {
    assertCan(actor, 'read', { objectType: 'activity' });

    const row = await this.loadOrNotFound(tx, actor, id);
    // Out of scope raises 404, not 403, so the endpoint cannot be used to
    // discover that an id exists (CLAUDE.md §5.5).
    assertCan(actor, 'read', {
      objectType: 'activity',
      record: await recordRefFor(tx, actor, row.assignedTo),
    });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');
    const links = await this.resolveLinks(tx, actor, [row]);
    return serializeActivity(actor, row, fields, links.get(row.id) ?? []);
  }

  async create(
    actor: Actor,
    input: ActivityCreateInput,
    idempotencyKey?: string,
  ): Promise<SerializedActivity> {
    return this.inTenant(actor, (tx) =>
      this.idempotency.once(
        tx,
        actor,
        idempotencyKey,
        { objectType: 'activity', action: 'create' },
        input,
        async () => {
          const activity = await this.createInTx(actor, tx, input);
          return { answer: activity, reference: { recordId: activity['id'] as string } };
        },
        (reference) => this.getByIdInTx(actor, tx, reference.recordId),
      ),
    );
  }

  /**
   * Create an activity inside a transaction somebody else owns.
   *
   * Public for the same reason `ContactsService.createInTx` is: a future flow
   * that creates several records at once — logging a call while converting a
   * lead, say — must be all-or-nothing and must get these exact checks, the
   * audit entry and the events, rather than a copy of them.
   */
  async createInTx(actor: Actor, tx: Tx, input: ActivityCreateInput): Promise<SerializedActivity> {
    assertCan(actor, 'create', { objectType: 'activity' });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');
    assertWritableActivityFields(actor, input, fields);

    const customFields = this.validateCustomFields(input.customFields ?? {}, fields, false);
    const assignedTo = await this.resolveAssignee(tx, actor, input.assignedTo ?? undefined);

    const now = new Date();
    const type = input.type;
    const dueAt = this.parseDueAt(type, input.dueAt ?? null);
    const status = input.status ?? 'open';
    const completedAt = status === 'completed' ? now : null;
    if (type === 'note' && status === 'completed') {
      throw new ValidationError([
        { path: 'status', message: 'A note is a record of something, not something to complete' },
      ]);
    }
    const reminderAt = reminderInstantFor(type, dueAt, now, input.reminderMinutesBefore ?? 0);

    const links = await this.resolveRequestedLinks(tx, actor, input.links ?? []);

    const row = await this.repository.insert(tx, {
      id: newId(),
      tenantId: actor.tenantId,
      assignedTo,
      type,
      subject: input.subject,
      // Sanitized before it is stored, so nothing dangerous is ever at rest
      // (ADR-0024). The serializer sanitizes again on the way out.
      body: sanitizeRichText(input.body ?? null),
      dueAt,
      completedAt,
      priority: input.priority ?? 'normal',
      status,
      reminderAt,
      customFields,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });

    for (const link of links) {
      await this.repository.insertLink(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        activityId: row.id,
        objectType: link.objectType,
        recordId: link.recordId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
    }

    // Same transaction as the insert: the audit entry and the events exist if
    // and only if the activity does (CLAUDE.md §5.10, ADR-0006).
    await this.audit.record(tx, actor, {
      action: 'create',
      objectType: 'activity',
      recordId: row.id,
      changes: diffChanges(
        {},
        { type: row.type, subject: row.subject, assignedTo: row.assignedTo, dueAt: row.dueAt },
      ),
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'activity.created.v1',
      objectType: 'activity',
      recordId: row.id,
      payload: { assignedTo: row.assignedTo, type: row.type },
    });

    for (const link of links) {
      await this.publishLinked(tx, actor, row, link);
    }
    await this.publishAssignment(tx, actor, row);
    await this.publishReminder(tx, actor, row);

    const fieldsForLinks = new Map<string, readonly ActivityLinkView[]>([[row.id, links]]);
    return serializeActivity(actor, row, fields, fieldsForLinks.get(row.id) ?? []);
  }

  async update(actor: Actor, id: string, input: ActivityUpdateInput): Promise<SerializedActivity> {
    assertCan(actor, 'update', { objectType: 'activity' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', {
        objectType: 'activity',
        record: await recordRefFor(tx, actor, existing.assignedTo),
      });

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');
      assertWritableActivityFields(actor, input, fields);

      const patch = await this.buildPatch(tx, actor, input, existing, fields);

      const updated = await this.repository.updateWithVersion(
        tx,
        actor.tenantId,
        id,
        input.version,
        { ...patch, updatedBy: actor.userId },
      );

      if (updated === null) {
        // The row exists — we just loaded it — so a zero-row update means the
        // version moved: somebody else saved first. 409, never a silent clobber.
        throw new VersionConflictError('activity');
      }

      const changes = diffChanges(existing, updated);

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'activity',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'activity.updated.v1',
        objectType: 'activity',
        recordId: id,
        payload: { changedFields: Object.keys(changes) },
      });

      // Handing work to somebody else is news to them, and a reminder that
      // now points at a different time needs rescheduling. Both are events,
      // never an inline notification or a timer (ADR-0006, ADR-0025).
      if (updated.assignedTo !== existing.assignedTo) {
        await this.publishAssignment(tx, actor, updated);
      }
      if (updated.reminderAt?.getTime() !== existing.reminderAt?.getTime()) {
        await this.publishReminder(tx, actor, updated);
      }
      if (updated.status === 'completed' && existing.status !== 'completed') {
        await this.publishCompleted(tx, actor, updated);
      }

      const links = await this.resolveLinks(tx, actor, [updated]);
      return serializeActivity(actor, updated, fields, links.get(updated.id) ?? []);
    });
  }

  /**
   * Tell the new assignee, and re-time the reminder for them, after an
   * administrator has reassigned these activities (MVP_SPEC M3).
   *
   * The write itself is the access module's one shared statement; this is the
   * part only this module knows — that handing somebody work is news to them
   * (ADR-0025) — and it is the very same pair of events an ordinary edit
   * publishes, so the worker follows without knowing a reassignment happened.
   */
  async announceReassigned(tx: Tx, actor: Actor, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const row = await this.repository.findById(tx, actor.tenantId, id);
      if (row === null) continue;
      await this.publishAssignment(tx, actor, row);
      await this.publishReminder(tx, actor, row);
    }
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'activity' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'delete', {
        objectType: 'activity',
        record: await recordRefFor(tx, actor, existing.assignedTo),
      });

      const deleted = await this.repository.softDelete(
        tx,
        actor.tenantId,
        id,
        actor.userId,
        version,
      );
      if (deleted === null) throw new VersionConflictError('activity');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'activity',
        recordId: id,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'activity.deleted.v1',
        objectType: 'activity',
        recordId: id,
      });
    });
  }

  /** Attach this activity to another record (ADR-0005). */
  async addLink(actor: Actor, id: string, input: ActivityLinkInput): Promise<SerializedActivity> {
    assertCan(actor, 'update', { objectType: 'activity' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', {
        objectType: 'activity',
        record: await recordRefFor(tx, actor, existing.assignedTo),
      });

      const [link] = await this.resolveRequestedLinks(tx, actor, [input]);
      if (link === undefined) throw new NotFoundError(input.objectType);

      await this.repository.insertLink(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        activityId: id,
        objectType: link.objectType,
        recordId: link.recordId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'activity',
        recordId: id,
        changes: { links: { new: `${link.objectType}:${link.recordId}` } },
      });
      await this.publishLinked(tx, actor, existing, link);

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');
      const links = await this.resolveLinks(tx, actor, [existing]);
      return serializeActivity(actor, existing, fields, links.get(id) ?? []);
    });
  }

  /** Detach this activity from a record. */
  async removeLink(actor: Actor, id: string, input: ActivityLinkInput): Promise<void> {
    assertCan(actor, 'update', { objectType: 'activity' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', {
        objectType: 'activity',
        record: await recordRefFor(tx, actor, existing.assignedTo),
      });

      // Detaching needs no read permission on the target: the caller can
      // already see that *something* is linked, and refusing to let them
      // remove a link they cannot resolve would leave the activity stuck.
      const removed = await this.repository.deleteLink(
        tx,
        actor.tenantId,
        id,
        input.objectType,
        input.recordId,
      );
      if (!removed) throw new NotFoundError('Link');

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'activity',
        recordId: id,
        changes: { links: { old: `${input.objectType}:${input.recordId}` } },
      });
    });
  }

  /**
   * What to call these activities, for the ones this actor may read.
   *
   * The same contract `ContactsService.linkLabels` documents, and the way
   * global search resolves an activity hit without touching this module's
   * tables (ADR-0001, ADR-0028): the reader's record scope is applied in SQL,
   * so an activity they may not see is simply absent from the answer, and the
   * label is built only from a field they may read — so neither the list nor
   * the label is a side door around a permission.
   *
   * Activities are not link *targets* (ADR-0005 keeps that set to the four
   * record types), so unlike the other four this exists for search alone.
   */
  async linkLabels(tx: Tx, actor: Actor, ids: readonly string[]): Promise<Map<string, string>> {
    const decision = can(actor, 'read', { objectType: 'activity' });
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
        canReadField(actor, 'activity', 'subject') && row.subject.length > 0
          ? row.subject
          : 'Activity',
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
   * can list the files on a colleague's activity and not touch them. A
   * record outside the caller's reach is indistinguishable from one that does
   * not exist, which is what stops the polymorphic pair becoming a way around
   * record scope (CLAUDE.md §5.5).
   */
  async allowsRecordAction(tx: Tx, actor: Actor, action: Action, id: string): Promise<boolean> {
    const decision = can(actor, action, { objectType: 'activity' });
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
   * Load a record or raise 404.
   *
   * RLS has already excluded other tenants, so "not found" covers both a
   * genuinely missing record and one belonging to someone else —
   * indistinguishable from outside, which is the point (CLAUDE.md §5.5).
   */
  private async loadOrNotFound(tx: Tx, actor: Actor, id: string): Promise<ActivityRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row === null) throw new NotFoundError('Activity');
    return row;
  }

  /**
   * The links on these activities, filtered to what this reader may see.
   *
   * This is the second half of the ADR-0005 bargain. A link whose target does
   * not resolve for the actor is simply absent from the response — not
   * nulled, not labelled "hidden", which would still confirm it exists.
   */
  private async resolveLinks(
    tx: Tx,
    actor: Actor,
    rows: readonly ActivityRow[],
  ): Promise<Map<string, ActivityLinkView[]>> {
    const byActivity = new Map<string, ActivityLinkView[]>();
    if (rows.length === 0) return byActivity;

    const linkRows = await this.repository.linksFor(
      tx,
      actor.tenantId,
      rows.map((row) => row.id),
    );
    if (linkRows.length === 0) return byActivity;

    const resolved = await this.recordLinks.resolveMany(
      tx,
      actor,
      linkRows.map((link) => ({
        objectType: link.objectType as LinkTargetType,
        recordId: link.recordId,
      })),
    );

    for (const link of linkRows) {
      const target = resolved.get(keyFor(link.objectType, link.recordId));
      if (target === undefined) continue;
      const list = byActivity.get(link.activityId) ?? [];
      list.push({
        objectType: target.objectType,
        recordId: target.recordId,
        label: target.label,
      });
      byActivity.set(link.activityId, list);
    }

    return byActivity;
  }

  /**
   * Turn requested links into real ones, or refuse.
   *
   * A target the caller cannot read is a 422 with the same message as one
   * that does not exist, so the error cannot be used to find out which ids
   * are real (ADR-0005, CLAUDE.md §5.5).
   */
  private async resolveRequestedLinks(
    tx: Tx,
    actor: Actor,
    requested: readonly ActivityLinkInput[],
  ): Promise<ActivityLinkView[]> {
    if (requested.length === 0) return [];

    const resolved = await this.recordLinks.resolveMany(tx, actor, requested);
    const links: ActivityLinkView[] = [];

    for (const [index, ref] of requested.entries()) {
      const target = resolved.get(keyFor(ref.objectType, ref.recordId));
      if (target === undefined) {
        throw new ValidationError([
          { path: `links.${index}.recordId`, message: 'That record does not exist' },
        ]);
      }
      links.push({
        objectType: target.objectType,
        recordId: target.recordId,
        label: target.label,
      });
    }

    return links;
  }

  /**
   * Who may this activity be assigned to?
   *
   * Wider than the rule on contacts, deliberately. Reassigning a *record*
   * moves who owns a customer, which is an `all`-scope act; handing somebody
   * a task is ordinary management, and a Manager with `team` scope who could
   * not give work to their own team would be unable to do their job. So the
   * rule follows the scope: `all` may assign to any active member, `team` to
   * anyone sharing a team, `own` only to themselves.
   *
   * The membership check also means an id from another tenant cannot be
   * written into the column — RLS would hide the rows, but the column is a
   * plain uuid and nothing else would notice.
   */
  private async resolveAssignee(
    tx: Tx,
    actor: Actor,
    requested: string | undefined,
  ): Promise<string> {
    if (requested === undefined || requested === actor.userId) return actor.userId;

    const decision = can(actor, 'update', { objectType: 'activity' });
    if (!decision.allowed || decision.scope === 'own') {
      throw new ValidationError([
        { path: 'assignedTo', message: 'You cannot assign work to another user' },
      ]);
    }

    const teamIds = decision.scope === 'team' ? actor.teamIds : null;
    const assignable = await this.repository.isAssignable(tx, actor.tenantId, requested, teamIds);
    if (!assignable) {
      throw new ValidationError([
        { path: 'assignedTo', message: 'You cannot assign work to that user' },
      ]);
    }
    return requested;
  }

  private parseDueAt(type: ActivityType, value: string | null): Date | null {
    if (value === null) return null;
    if (!isSchedulable(type)) {
      throw new ValidationError([
        { path: 'dueAt', message: 'A note has nothing to be due; use a task instead' },
      ]);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError([{ path: 'dueAt', message: 'Not a valid date and time' }]);
    }
    return parsed;
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

  private async buildPatch(
    tx: Tx,
    actor: Actor,
    input: ActivityUpdateInput,
    existing: ActivityRow,
    fields: readonly FieldDefinition[],
  ): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    const now = new Date();

    if (input.subject !== undefined) patch['subject'] = input.subject;
    if (input.priority !== undefined) patch['priority'] = input.priority;
    if (input.type !== undefined) patch['type'] = input.type;
    if (input.body !== undefined) patch['body'] = sanitizeRichText(input.body);

    const type: ActivityType = input.type ?? existing.type;

    if (input.dueAt !== undefined) {
      patch['dueAt'] = this.parseDueAt(type, input.dueAt ?? null);
    }

    if (input.status !== undefined) {
      patch['status'] = input.status;
      // The timestamp follows the status rather than being settable, so the
      // two cannot disagree — the database refuses a row where they do.
      patch['completedAt'] = input.status === 'completed' ? now : null;
    }

    if (input.assignedTo !== undefined) {
      patch['assignedTo'] = await this.resolveAssignee(tx, actor, input.assignedTo ?? undefined);
    }

    // A reminder is derived, never set. Recomputed whenever the due date or
    // the lead time moves, so a rescheduled task cannot keep a reminder
    // pointing at the old time (ADR-0025).
    const dueChanged = 'dueAt' in patch;
    const leadChanged = input.reminderMinutesBefore !== undefined;
    const statusChanged = input.status !== undefined;
    if (dueChanged || leadChanged || statusChanged || input.type !== undefined) {
      const dueAt = (dueChanged ? (patch['dueAt'] as Date | null) : existing.dueAt) ?? null;
      const status = (patch['status'] as string | undefined) ?? existing.status;
      patch['reminderAt'] =
        status === 'open'
          ? reminderInstantFor(type, dueAt, now, input.reminderMinutesBefore ?? 0)
          : null;
    }

    if (input.customFields !== undefined) {
      const validated = this.validateCustomFields(input.customFields, fields, true);
      // Merge rather than replace: a PATCH naming one custom field must not
      // wipe the others the caller never mentioned.
      patch['customFields'] = { ...existing.customFields, ...validated };
    }

    return patch;
  }

  /**
   * "This activity now concerns that record."
   *
   * Published per link, with the **target's** object type and id, so the
   * worker's timeline projector writes one entry onto the record's own feed.
   * One event per link rather than one event with a list: the timeline's
   * idempotency key is the source event, and a fan-out inside the handler
   * would need a second key to stay safe under at-least-once delivery.
   */
  private async publishLinked(
    tx: Tx,
    actor: Actor,
    activity: ActivityRow,
    link: ActivityLinkView,
  ): Promise<void> {
    await this.outbox.publish(tx, actor, {
      eventType: 'activity.linked.v1',
      objectType: link.objectType,
      recordId: link.recordId,
      payload: {
        activityId: activity.id,
        activityType: activity.type,
        subject: activity.subject,
        dueAt: activity.dueAt?.toISOString() ?? null,
      },
    });
  }

  private async publishCompleted(tx: Tx, actor: Actor, activity: ActivityRow): Promise<void> {
    const links = await this.repository.linksFor(tx, actor.tenantId, [activity.id]);
    for (const link of links) {
      await this.outbox.publish(tx, actor, {
        eventType: 'activity.completed.v1',
        objectType: link.objectType,
        recordId: link.recordId,
        payload: { activityId: activity.id, subject: activity.subject },
      });
    }
  }

  /**
   * Somebody else was given this work.
   *
   * Not published when a person assigns something to themselves: they already
   * know, and a notification for it is noise that teaches people to ignore
   * the bell.
   */
  private async publishAssignment(tx: Tx, actor: Actor, activity: ActivityRow): Promise<void> {
    if (activity.assignedTo === null || activity.assignedTo === actor.userId) return;

    await this.outbox.publish(tx, actor, {
      eventType: 'activity.assigned.v1',
      objectType: 'activity',
      recordId: activity.id,
      payload: {
        assignedTo: activity.assignedTo,
        subject: activity.subject,
        type: activity.type,
        dueAt: activity.dueAt?.toISOString() ?? null,
      },
    });
  }

  /**
   * Schedule the reminder by writing an outbox row that is not deliverable
   * until it is due (ADR-0025).
   *
   * The outbox already has `available_at` and the relay already refuses to
   * pick a row up before it, so a reminder needs no timer, no scheduler and
   * no cross-tenant sweep — and it survives a restart because it is a
   * committed row rather than something in a process's memory.
   *
   * A reminder that is later moved or cancelled leaves this row behind. The
   * handler re-reads the activity when it fires and does nothing if the
   * reminder no longer matches, which is why the instant is in the payload.
   */
  private async publishReminder(tx: Tx, actor: Actor, activity: ActivityRow): Promise<void> {
    if (activity.reminderAt === null || activity.assignedTo === null) return;

    await this.outbox.publish(
      tx,
      actor,
      {
        eventType: 'activity.reminder_due.v1',
        objectType: 'activity',
        recordId: activity.id,
        payload: {
          assignedTo: activity.assignedTo,
          subject: activity.subject,
          reminderAt: activity.reminderAt.toISOString(),
        },
      },
      { availableAt: activity.reminderAt },
    );
  }
}
