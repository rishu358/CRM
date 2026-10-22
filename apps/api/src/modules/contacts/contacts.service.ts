import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  can,
  canReadField,
  MAX_DUPLICATE_MATCHES,
  newId,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  type Action,
  type Actor,
  type FieldDefinition,
} from '@crm/core';
import {
  parseFilter,
  parseSort,
  toFilterList,
  type ContactCreateInput,
  type ContactListQuery,
  type ContactUpdateInput,
  type DuplicateMatch,
} from '@crm/contracts';
import { recordRefFor, type Contact as ContactRow, type Tx } from '@crm/db';
import {
  assertFiltersReadable,
  assertSortable,
  readableSearchFields,
} from '../../common/field-queries.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { ContactsRepository } from './contacts.repository.js';
import {
  assertWritableContactFields,
  serializeContact,
  serializeContacts,
  type SerializedContact,
} from './contacts.serializer.js';
import { allowedSortKeys, SEARCH_FIELD_KEYS } from './contacts.sql-helpers.js';

/**
 * Contacts business logic (CLAUDE.md §11.2).
 *
 * The shape every other module will copy:
 *   1. authorize with `can()` before anything else
 *   2. validate custom fields against this tenant's metadata
 *   3. check field-level write permission
 *   4. do the write, the audit entry and the outbox event in ONE transaction
 *   5. serialize through the field-permission filter on the way out
 *
 * Steps 4 and 5 are the ones that are easy to get subtly wrong, which is why
 * this is a template rather than something each module reinvents.
 */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ContactsRepository) private readonly repository: ContactsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(
    actor: Actor,
    query: ContactListQuery,
  ): Promise<{ data: SerializedContact[]; meta: { nextCursor: string | null; hasMore: boolean } }> {
    // Collection-level check. The returned constraint becomes a WHERE clause,
    // so `own` scope never fetches another rep's rows in the first place.
    const decision = assertCan(actor, 'read', { objectType: 'contact' });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'contact');

      const sort = query.sort === undefined ? undefined : parseSort(query.sort);
      if (sort !== undefined) {
        assertSortable(actor, 'contact', sort.field, allowedSortKeys(fields));
      }

      const filters = toFilterList(query.filter).map((raw) => {
        const parsed = parseFilter(raw);
        if (parsed === null) {
          throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
        }
        return parsed;
      });
      assertFiltersReadable(actor, 'contact', filters);

      const result = await this.repository.list(tx, actor.tenantId, {
        constraint: decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
        limit: query.limit,
        cursor: query.cursor,
        sort,
        filters,
        search: query.q,
        searchFields: readableSearchFields(actor, 'contact', SEARCH_FIELD_KEYS),
        fields,
      });

      return {
        data: serializeContacts(actor, result.rows, fields),
        meta: { nextCursor: result.nextCursor, hasMore: result.hasMore },
      };
    });
  }

  async getById(actor: Actor, id: string): Promise<SerializedContact> {
    assertCan(actor, 'read', { objectType: 'contact' });

    return this.inTenant(actor, async (tx) => {
      const row = await this.loadOrNotFound(tx, actor, id);
      // Record-level check. Out of scope raises 404, not 403, so the endpoint
      // cannot be used to discover that an id exists (CLAUDE.md §5.5).
      assertCan(actor, 'read', {
        objectType: 'contact',
        record: await recordRefFor(tx, actor, row.ownerId),
      });

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'contact');
      return serializeContact(actor, row, fields);
    });
  }

  async create(actor: Actor, input: ContactCreateInput): Promise<SerializedContact> {
    return this.inTenant(actor, (tx) => this.createInTx(actor, tx, input));
  }

  /**
   * Create a contact inside a transaction somebody else owns.
   *
   * Lead conversion creates several records and must be all-or-nothing, so it
   * needs the very same checks, audit entry and outbox event `create` performs,
   * without opening a second transaction. Every guarantee `create` gives holds
   * here too: it is the same code, not a copy of it.
   */
  async createInTx(actor: Actor, tx: Tx, input: ContactCreateInput): Promise<SerializedContact> {
    assertCan(actor, 'create', { objectType: 'contact' });

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'contact');
    assertWritableContactFields(actor, input, fields);

    const customFields = this.validateCustomFields(input.customFields ?? {}, fields, false);
    const ownerId = this.resolveOwner(actor, input.ownerId ?? undefined);

    const row = await this.repository.insert(tx, {
      id: newId(),
      tenantId: actor.tenantId,
      ownerId,
      firstName: input.firstName ?? null,
      lastName: input.lastName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      whatsapp: input.whatsapp ?? null,
      title: input.title ?? null,
      accountId: input.accountId ?? null,
      leadSource: input.leadSource ?? null,
      customFields,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });

    // Same transaction as the insert: the audit entry and the event exist if
    // and only if the contact does (CLAUDE.md §5.10, ADR-0006).
    await this.audit.record(tx, actor, {
      action: 'create',
      objectType: 'contact',
      recordId: row.id,
      changes: diffChanges({}, { lastName: row.lastName, email: row.email, ownerId: row.ownerId }),
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'contact.created.v1',
      objectType: 'contact',
      recordId: row.id,
      payload: { ownerId: row.ownerId },
    });

    return serializeContact(actor, row, fields);
  }

  async update(actor: Actor, id: string, input: ContactUpdateInput): Promise<SerializedContact> {
    assertCan(actor, 'update', { objectType: 'contact' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', {
        objectType: 'contact',
        record: await recordRefFor(tx, actor, existing.ownerId),
      });

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'contact');
      assertWritableContactFields(actor, input, fields);

      const patch = this.buildPatch(actor, input, existing, fields);

      const updated = await this.repository.updateWithVersion(
        tx,
        actor.tenantId,
        id,
        input.version,
        {
          ...patch,
          updatedBy: actor.userId,
        },
      );

      if (updated === null) {
        // The row exists — we just loaded it — so a zero-row update means the
        // version moved: somebody else saved first. 409, never a silent clobber.
        throw new VersionConflictError('contact');
      }

      const changes = diffChanges(existing, updated);

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'contact',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'contact.updated.v1',
        objectType: 'contact',
        recordId: id,
        payload: { changedFields: Object.keys(changes) },
      });

      return serializeContact(actor, updated, fields);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'contact' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'delete', {
        objectType: 'contact',
        record: await recordRefFor(tx, actor, existing.ownerId),
      });

      const deleted = await this.repository.softDelete(
        tx,
        actor.tenantId,
        id,
        actor.userId,
        version,
      );
      if (deleted === null) throw new VersionConflictError('contact');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'contact',
        recordId: id,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'contact.deleted.v1',
        objectType: 'contact',
        recordId: id,
      });
    });
  }

  /**
   * Which of these ids name contacts another module may link to.
   *
   * The public way in, as `AccountsService.existsForLinking` is for accounts:
   * deals hold a `primary_contact_id` and a set of `deal_contacts`, and check
   * them through here rather than by querying the contacts table
   * (ADR-0001, CLAUDE.md §3). Tenant-scoped, not record-scoped, for the
   * reason given on the accounts version: attaching a person to a deal reveals
   * nothing about them, and reading them still goes through `getById`.
   */
  async existingIdsForLinking(
    tx: Tx,
    tenantId: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    return this.repository.existingIds(tx, tenantId, ids);
  }

  /**
   * Contacts this email or phone might already belong to (ADR-0023).
   *
   * Public so the leads module can ask without reaching into this module's
   * tables (ADR-0001). Three things keep it from being a side door around the
   * permission model, each of which is tested:
   *
   *   - it matches only on fields the **actor** may read: a caller who cannot
   *     see `phone` could otherwise probe for numbers one guess at a time;
   *   - it only returns contacts inside the actor's record scope, so an `own`
   *     rep is never told a colleague's contact exists;
   *   - the label shows only fields the actor may read.
   *
   * No permission on contacts at all is an empty answer, not an error: the
   * caller is creating a lead, which is not a reason to learn they lack access
   * to contacts.
   */
  async findDuplicates(
    tx: Tx,
    actor: Actor,
    criteria: {
      readonly email?: string | null | undefined;
      readonly phone?: string | null | undefined;
    },
  ): Promise<DuplicateMatch[]> {
    const decision = can(actor, 'read', { objectType: 'contact' });
    if (!decision.allowed) return [];

    const email =
      criteria.email != null && canReadField(actor, 'contact', 'email')
        ? criteria.email
        : undefined;
    const phone =
      criteria.phone != null && canReadField(actor, 'contact', 'phone')
        ? criteria.phone
        : undefined;

    const rows = await this.repository.findDuplicates(
      tx,
      actor.tenantId,
      { email, phone },
      decision.constraint,
      MAX_DUPLICATE_MATCHES,
    );

    return rows.map((row) => {
      const matchedOn: DuplicateMatch['matchedOn'] = [];
      if (email !== undefined && row.email === email) matchedOn.push('email');
      if (phone !== undefined && row.phone === phone) matchedOn.push('phone');

      const name = [
        canReadField(actor, 'contact', 'first_name') ? row.firstName : null,
        canReadField(actor, 'contact', 'last_name') ? row.lastName : null,
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(' ');

      return {
        objectType: 'contact',
        id: row.id,
        label: name.length > 0 ? name : 'Contact',
        matchedOn,
      };
    });
  }

  /**
   * A contact the caller may attach something to, or a 422.
   *
   * Narrower than `existingIdsForLinking`, on purpose. A deal may point at any
   * contact in the workspace; a lead conversion *adopts* the contact as the
   * person this lead became, which is a statement about a record the caller
   * should be able to see. The same message covers another tenant's id, a
   * deleted contact and a colleague's out-of-scope one, so the error cannot be
   * used to find out which ids exist.
   */
  async assertReadableForLinking(
    tx: Tx,
    actor: Actor,
    id: string,
    path: string,
  ): Promise<{ id: string; accountId: string | null }> {
    const decision = can(actor, 'read', { objectType: 'contact' });
    const row = decision.allowed
      ? await this.repository.findReadable(tx, actor.tenantId, id, decision.constraint)
      : null;
    if (row === null) {
      throw new ValidationError([{ path, message: 'That contact does not exist' }]);
    }
    return { id: row.id, accountId: row.accountId };
  }

  /**
   * What to call these contacts, for the ones this actor may read (ADR-0005).
   *
   * The public way for the activities module to resolve a polymorphic link
   * without touching this module's tables (ADR-0001). Two rules make it safe
   * to call with ids that came from a link row:
   *
   *   - the reader's record scope is applied in SQL, so an id they may not
   *     see is simply absent from the answer — which is how an activity
   *     linked to a colleague's contact stops being a way to learn the
   *     contact exists;
   *   - the label is built only from fields the actor may read, so a link is
   *     not a side door around field permissions.
   */
  async linkLabels(tx: Tx, actor: Actor, ids: readonly string[]): Promise<Map<string, string>> {
    const decision = can(actor, 'read', { objectType: 'contact' });
    if (!decision.allowed) return new Map();

    const rows = await this.repository.findReadableMany(
      tx,
      actor.tenantId,
      ids,
      decision.constraint,
    );

    return new Map(
      rows.map((row) => {
        const name = [
          canReadField(actor, 'contact', 'first_name') ? row.firstName : null,
          canReadField(actor, 'contact', 'last_name') ? row.lastName : null,
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(' ');
        return [row.id, name.length > 0 ? name : 'Contact'];
      }),
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
   * can list the files on a colleague's contact and not touch them. A
   * record outside the caller's reach is indistinguishable from one that does
   * not exist, which is what stops the polymorphic pair becoming a way around
   * record scope (CLAUDE.md §5.5).
   */
  async allowsRecordAction(tx: Tx, actor: Actor, action: Action, id: string): Promise<boolean> {
    const decision = can(actor, action, { objectType: 'contact' });
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
  private async loadOrNotFound(tx: Tx, actor: Actor, id: string): Promise<ContactRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row === null) throw new NotFoundError('Contact');
    return row;
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
    const decision = can(actor, 'update', { objectType: 'contact' });
    if (!decision.allowed || decision.scope !== 'all') {
      throw new ValidationError([
        { path: 'ownerId', message: 'You cannot assign records to another user' },
      ]);
    }
    return requestedOwnerId;
  }

  private buildPatch(
    actor: Actor,
    input: ContactUpdateInput,
    existing: ContactRow,
    fields: readonly FieldDefinition[],
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    for (const key of [
      'firstName',
      'lastName',
      'email',
      'phone',
      'whatsapp',
      'title',
      'accountId',
      'leadSource',
    ] as const) {
      if (key in input) patch[key] = input[key] ?? null;
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
