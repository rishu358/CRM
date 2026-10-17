import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  can,
  canReadField,
  canWriteField,
  companyDomainFromEmail,
  ConflictError,
  DuplicateRecordsError,
  LEAD_TO_CONTACT_FIELDS,
  MAX_DUPLICATE_MATCHES,
  newId,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  type Actor,
  type FieldDefinition,
  type ObjectType,
} from '@crm/core';
import {
  parseFilter,
  parseSort,
  toFilterList,
  type AccountCreateInput,
  type ContactCreateInput,
  type DealCreateInput,
  type DuplicateCheckInput,
  type DuplicateMatch,
  type LeadConversionResult,
  type LeadConvertRequest,
  type LeadCreateInput,
  type LeadListQuery,
  type LeadUpdateInput,
} from '@crm/contracts';
import type { Lead as LeadRow, Tx } from '@crm/db';
import { assertFiltersReadable, assertSortable } from '../../common/field-queries.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { DealsService } from '../deals/deals.service.js';
import { LeadsRepository } from './leads.repository.js';
import {
  assertWritableLeadFields,
  serializeLead,
  serializeLeads,
  type SerializedLead,
} from './leads.serializer.js';
import { allowedSortKeys } from './leads.sql-helpers.js';

/** The name column on a deal is 200 characters; a long company must not 422 the conversion. */
const MAX_DEAL_NAME = 200;

/**
 * Leads business logic (CLAUDE.md §11.2).
 *
 * The same five steps contacts, accounts and deals follow, in the same order:
 *   1. authorize with `can()` before anything else
 *   2. validate custom fields against this tenant's metadata
 *   3. check field-level write permission
 *   4. do the write, the audit entry and the outbox event in ONE transaction
 *   5. serialize through the field-permission filter on the way out
 *
 * Two things are this module's own:
 *
 * **Conversion is one transaction** (ADR-0022). It creates or links a contact
 * and an account, optionally creates a deal, and marks the lead converted. All
 * of it happens in a single `runInTenant`, through the other modules' own
 * `createInTx` methods so every record gets exactly the audit entry, outbox
 * event, custom-field validation and field-permission checks it would get if
 * created on its own. If any step fails — including the final version check
 * on the lead — everything rolls back: a half-converted lead is worse than a
 * failed conversion.
 *
 * **Duplicates are offered, never imposed** (ADR-0023). Matching is
 * delegated to each owning module, because only that module can apply the
 * actor's record scope and field permissions to its own records. A match the
 * actor may not read is never returned — not as a name, not as a count — which
 * is what stops this being a way to probe other people's books.
 */
@Injectable()
export class LeadsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LeadsRepository) private readonly repository: LeadsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(DealsService) private readonly deals: DealsService,
  ) {}

  async list(
    actor: Actor,
    query: LeadListQuery,
  ): Promise<{ data: SerializedLead[]; meta: { nextCursor: string | null; hasMore: boolean } }> {
    // Collection-level check. The returned constraint becomes a WHERE clause,
    // so `own` scope never fetches another rep's rows in the first place.
    const decision = assertCan(actor, 'read', { objectType: 'lead' });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');

      const sort = query.sort === undefined ? undefined : parseSort(query.sort);
      if (sort !== undefined) {
        assertSortable(actor, 'lead', sort.field, allowedSortKeys(fields));
      }

      const filters = toFilterList(query.filter).map((raw) => {
        const parsed = parseFilter(raw);
        if (parsed === null) {
          throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
        }
        return parsed;
      });
      assertFiltersReadable(actor, 'lead', filters);

      const result = await this.repository.list(tx, actor.tenantId, {
        constraint: decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
        limit: query.limit,
        cursor: query.cursor,
        sort,
        filters,
        search: query.q,
        fields,
      });

      return {
        data: serializeLeads(actor, result.rows, fields),
        meta: { nextCursor: result.nextCursor, hasMore: result.hasMore },
      };
    });
  }

  async getById(actor: Actor, id: string): Promise<SerializedLead> {
    assertCan(actor, 'read', { objectType: 'lead' });

    return this.inTenant(actor, async (tx) => {
      const row = await this.loadOrNotFound(tx, actor, id);
      // Record-level check. Out of scope raises 404, not 403, so the endpoint
      // cannot be used to discover that an id exists (CLAUDE.md §5.5).
      assertCan(actor, 'read', { objectType: 'lead', record: { ownerId: row.ownerId } });

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
      return serializeLead(actor, row, fields);
    });
  }

  /**
   * Create a lead, and report what it might duplicate.
   *
   * The lead is always created: matches are information for the person, never
   * a reason to refuse (MVP_SPEC M4, ADR-0023). The web app calls
   * `checkDuplicates` first so the prompt appears *before* the save; the
   * matches returned here cover every other client — an API caller, an import,
   * a form on a website — which gets the same information after the fact.
   */
  async create(
    actor: Actor,
    input: LeadCreateInput,
  ): Promise<{ lead: SerializedLead; duplicates: DuplicateMatch[] }> {
    assertCan(actor, 'create', { objectType: 'lead' });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
      assertWritableLeadFields(actor, input, fields);

      const customFields = this.validateCustomFields(input.customFields ?? {}, fields, false);
      const ownerId = this.resolveOwner(actor, input.ownerId ?? undefined);

      const row = await this.repository.insert(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        ownerId,
        firstName: input.firstName ?? null,
        lastName: input.lastName,
        company: input.company ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        source: input.source ?? null,
        status: input.status ?? 'new',
        customFields,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      // Same transaction as the insert: the audit entry and the event exist if
      // and only if the lead does (CLAUDE.md §5.10, ADR-0006).
      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'lead',
        recordId: row.id,
        changes: diffChanges(
          {},
          {
            lastName: row.lastName,
            company: row.company,
            email: row.email,
            status: row.status,
            ownerId: row.ownerId,
          },
        ),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead.created.v1',
        objectType: 'lead',
        recordId: row.id,
        payload: { ownerId: row.ownerId },
      });

      const duplicates = await this.duplicatesFor(tx, actor, {
        email: row.email,
        phone: row.phone,
        company: row.company,
        excludeLeadId: row.id,
      });

      return { lead: serializeLead(actor, row, fields), duplicates };
    });
  }

  async update(actor: Actor, id: string, input: LeadUpdateInput): Promise<SerializedLead> {
    assertCan(actor, 'update', { objectType: 'lead' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', { objectType: 'lead', record: { ownerId: existing.ownerId } });

      // A converted lead is a record of what happened, not a working record:
      // editing it would let it drift from the contact it became (ADR-0022).
      if (existing.status === 'converted') throw alreadyConverted();

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
      assertWritableLeadFields(actor, input, fields);

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
        throw new VersionConflictError('lead');
      }

      const changes = diffChanges(existing, updated);

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead.updated.v1',
        objectType: 'lead',
        recordId: id,
        payload: { changedFields: Object.keys(changes) },
      });

      return serializeLead(actor, updated, fields);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'lead' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'delete', { objectType: 'lead', record: { ownerId: existing.ownerId } });

      const deleted = await this.repository.softDelete(
        tx,
        actor.tenantId,
        id,
        actor.userId,
        version,
      );
      if (deleted === null) throw new VersionConflictError('lead');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'lead',
        recordId: id,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead.deleted.v1',
        objectType: 'lead',
        recordId: id,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Duplicate detection (ADR-0023)
  // -------------------------------------------------------------------------

  /**
   * What would this lead duplicate, before it is saved?
   *
   * Gated on `create` for leads: it is part of the create flow, and a role that
   * cannot create leads has no business running a lookup over other people's
   * records. Even so it answers only from what the actor may read.
   */
  async checkDuplicates(actor: Actor, input: DuplicateCheckInput): Promise<DuplicateMatch[]> {
    assertCan(actor, 'create', { objectType: 'lead' });

    return this.inTenant(actor, (tx) =>
      this.duplicatesFor(tx, actor, {
        email: input.email ?? null,
        phone: input.phone ?? null,
        company: input.company ?? null,
      }),
    );
  }

  /**
   * What would converting this lead duplicate?
   *
   * Drives the "link to existing" choice in the conversion dialog. Only the
   * values of the lead the actor may read are used to look, so a hidden email
   * on the lead cannot be used to find out which contact holds it.
   */
  async conversionMatches(actor: Actor, id: string): Promise<DuplicateMatch[]> {
    assertCan(actor, 'update', { objectType: 'lead' });

    return this.inTenant(actor, async (tx) => {
      const lead = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', { objectType: 'lead', record: { ownerId: lead.ownerId } });

      const visible = this.visibleValues(actor, lead);
      return this.duplicatesFor(tx, actor, {
        email: visible.email,
        phone: visible.phone,
        company: visible.company,
        excludeLeadId: lead.id,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Conversion (ADR-0022)
  // -------------------------------------------------------------------------

  async convert(
    actor: Actor,
    id: string,
    input: LeadConvertRequest,
  ): Promise<LeadConversionResult> {
    assertCan(actor, 'update', { objectType: 'lead' });

    // One transaction for everything below. Nothing in this method opens
    // another, and nothing it calls does either: every record is created
    // through the owning module's `createInTx`, which takes this `tx`.
    return this.inTenant(actor, async (tx) => {
      const lead = await this.loadOrNotFound(tx, actor, id);
      assertCan(actor, 'update', { objectType: 'lead', record: { ownerId: lead.ownerId } });

      if (lead.status === 'converted') throw alreadyConverted();
      if (lead.version !== input.version) throw new VersionConflictError('lead');

      const leadFields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
      const visible = this.visibleValues(actor, lead);
      const skipped: string[] = [];

      const accountChoice =
        input.account ??
        (visible.company === null ? { mode: 'none' as const } : { mode: 'create' as const });
      const contactChoice = input.contact ?? { mode: 'create' as const };
      const accountDomain = companyDomainFromEmail(visible.email);

      // --- duplicates, before anything is written ----------------------------
      // Only a record the conversion is about to *create* can be a duplicate;
      // linking to an existing one is the answer, not the problem. Both checks
      // run before the first insert so one 409 lists every match, and so the
      // client never has to resolve them one round trip at a time.
      if (!input.acknowledgeDuplicates) {
        const contactMatches =
          contactChoice.mode === 'create'
            ? await this.contacts.findDuplicates(tx, actor, {
                email: visible.email,
                phone: visible.phone,
              })
            : [];
        const accountMatches =
          accountChoice.mode === 'create' && visible.company !== null
            ? await this.accounts.findDuplicates(tx, actor, {
                domain: accountDomain,
                name: visible.company,
              })
            : [];
        if (contactMatches.length > 0 || accountMatches.length > 0) {
          throw duplicateFound([
            ...contactMatches.map((match) => ({ path: 'contact' as const, match })),
            ...accountMatches.map((match) => ({ path: 'account' as const, match })),
          ]);
        }
      }

      // --- the account first, so the contact can point at it ----------------

      let accountId: string | null = null;
      let accountCreated = false;

      if (accountChoice.mode === 'link') {
        accountId = (
          await this.accounts.assertReadableForLinking(
            tx,
            actor,
            accountChoice.accountId,
            'account.accountId',
          )
        ).id;
      } else if (accountChoice.mode === 'create') {
        if (visible.company === null) {
          throw new ValidationError([
            { path: 'account', message: 'This lead has no company to create an account from' },
          ]);
        }
        const accountInput: Record<string, unknown> = { name: visible.company };
        if (accountDomain !== null) {
          if (canWriteField(actor, 'account', 'domain')) accountInput['domain'] = accountDomain;
          else skipped.push('account.domain');
        }
        const accountOwner = this.ownerForTarget(actor, lead, 'account');
        if (accountOwner !== undefined) accountInput['ownerId'] = accountOwner;

        const account = await this.accounts.createInTx(
          actor,
          tx,
          accountInput as AccountCreateInput,
        );
        accountId = account['id'] as string;
        accountCreated = true;
      }

      // --- the contact ------------------------------------------------------
      let contactId: string;
      let contactCreated = false;

      if (contactChoice.mode === 'link') {
        contactId = (
          await this.contacts.assertReadableForLinking(
            tx,
            actor,
            contactChoice.contactId,
            'contact.contactId',
          )
        ).id;
      } else {
        const contactFields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'contact');
        const contactInput = this.mapToContact(actor, lead, leadFields, contactFields, skipped);
        if (accountId !== null) contactInput['accountId'] = accountId;
        const contactOwner = this.ownerForTarget(actor, lead, 'contact');
        if (contactOwner !== undefined) contactInput['ownerId'] = contactOwner;

        const contact = await this.contacts.createInTx(
          actor,
          tx,
          contactInput as unknown as ContactCreateInput,
        );
        contactId = contact['id'] as string;
        contactCreated = true;
      }

      // --- the deal, if one was asked for -----------------------------------
      let dealId: string | null = null;
      if (input.deal !== undefined && input.deal !== null) {
        const dealInput: Record<string, unknown> = {
          name: input.deal.name ?? defaultDealName(visible.company, lead.lastName),
          primaryContactId: contactId,
        };
        if (accountId !== null) dealInput['accountId'] = accountId;
        if (input.deal.pipelineId !== undefined) dealInput['pipelineId'] = input.deal.pipelineId;
        if (input.deal.stageId !== undefined) dealInput['stageId'] = input.deal.stageId;
        if (input.deal.amount !== undefined) dealInput['amount'] = input.deal.amount;
        if (input.deal.expectedCloseDate !== undefined) {
          dealInput['expectedCloseDate'] = input.deal.expectedCloseDate;
        }
        const dealOwner = this.ownerForTarget(actor, lead, 'deal');
        if (dealOwner !== undefined) dealInput['ownerId'] = dealOwner;

        const deal = await this.deals.createInTx(
          actor,
          tx,
          dealInput as unknown as DealCreateInput,
        );
        dealId = deal['id'] as string;
      }

      // --- finally, the lead itself ----------------------------------------
      const converted = await this.repository.markConverted(tx, actor.tenantId, id, input.version, {
        convertedAt: new Date(),
        convertedContactId: contactId,
        convertedAccountId: accountId,
        convertedDealId: dealId,
        updatedBy: actor.userId,
      });
      // Zero rows: the version moved, or somebody converted it first. Throwing
      // here rolls back the contact, the account and the deal created above.
      if (converted === null) throw new VersionConflictError('lead');

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead',
        recordId: id,
        changes: diffChanges(lead, converted),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead.converted.v1',
        objectType: 'lead',
        recordId: id,
        payload: {
          contactId,
          accountId,
          dealId,
          contactCreated,
          accountCreated,
        },
      });

      // A record that was only linked gets no `created` event of its own, so
      // its history would never mention the lead. These say so.
      if (!contactCreated) {
        await this.outbox.publish(tx, actor, {
          eventType: 'contact.linked_from_lead.v1',
          objectType: 'contact',
          recordId: contactId,
          payload: { leadId: id },
        });
      }
      if (accountId !== null && !accountCreated) {
        await this.outbox.publish(tx, actor, {
          eventType: 'account.linked_from_lead.v1',
          objectType: 'account',
          recordId: accountId,
          payload: { leadId: id },
        });
      }

      return {
        lead: serializeLead(actor, converted, leadFields) as LeadConversionResult['lead'],
        contact: { id: contactId, created: contactCreated },
        account: accountId === null ? null : { id: accountId, created: accountCreated },
        deal: dealId === null ? null : { id: dealId },
        skippedFields: skipped,
      };
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * What to call these leads, for the ones this actor may read (ADR-0005).
   *
   * See `ContactsService.linkLabels`: record scope in SQL, label built only
   * from readable fields, absent rather than refused when either says no.
   */
  async linkLabels(tx: Tx, actor: Actor, ids: readonly string[]): Promise<Map<string, string>> {
    const decision = can(actor, 'read', { objectType: 'lead' });
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
          canReadField(actor, 'lead', 'first_name') ? row.firstName : null,
          canReadField(actor, 'lead', 'last_name') ? row.lastName : null,
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(' ');
        const company = canReadField(actor, 'lead', 'company') ? row.company : null;
        const label = [name, company]
          .filter((part) => part !== null && part.length > 0)
          .join(' — ');
        return [row.id, label.length > 0 ? label : 'Lead'];
      }),
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
  private async loadOrNotFound(tx: Tx, actor: Actor, id: string): Promise<LeadRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row === null) throw new NotFoundError('Lead');
    return row;
  }

  /**
   * The lead values this actor may read, and so may be used to look for
   * duplicates and copied onto other records. A value the actor cannot see is
   * `null`: acting on it would reveal it.
   */
  private visibleValues(
    actor: Actor,
    lead: LeadRow,
  ): { email: string | null; phone: string | null; company: string | null } {
    return {
      email: canReadField(actor, 'lead', 'email') ? lead.email : null,
      phone: canReadField(actor, 'lead', 'phone') ? lead.phone : null,
      company: canReadField(actor, 'lead', 'company') ? lead.company : null,
    };
  }

  /**
   * Everything a lead with these values might duplicate: other leads, contacts
   * and accounts. Each owning module applies the actor's record scope and field
   * permissions to its own records; this only asks and concatenates.
   */
  private async duplicatesFor(
    tx: Tx,
    actor: Actor,
    criteria: {
      readonly email: string | null;
      readonly phone: string | null;
      readonly company: string | null;
      readonly excludeLeadId?: string | undefined;
    },
  ): Promise<DuplicateMatch[]> {
    const [leads, contacts, accounts] = [
      await this.leadDuplicates(tx, actor, criteria),
      await this.contacts.findDuplicates(tx, actor, {
        email: criteria.email,
        phone: criteria.phone,
      }),
      await this.accounts.findDuplicates(tx, actor, {
        domain: companyDomainFromEmail(criteria.email),
        name: criteria.company,
      }),
    ];
    return [...leads, ...contacts, ...accounts];
  }

  private async leadDuplicates(
    tx: Tx,
    actor: Actor,
    criteria: {
      readonly email: string | null;
      readonly phone: string | null;
      readonly excludeLeadId?: string | undefined;
    },
  ): Promise<DuplicateMatch[]> {
    const decision = can(actor, 'read', { objectType: 'lead' });
    if (!decision.allowed) return [];

    const email =
      criteria.email !== null && canReadField(actor, 'lead', 'email') ? criteria.email : undefined;
    const phone =
      criteria.phone !== null && canReadField(actor, 'lead', 'phone') ? criteria.phone : undefined;

    const rows = await this.repository.findDuplicates(
      tx,
      actor.tenantId,
      { email, phone, excludeId: criteria.excludeLeadId },
      decision.constraint,
      MAX_DUPLICATE_MATCHES,
    );

    return rows.map((row) => {
      const matchedOn: DuplicateMatch['matchedOn'] = [];
      if (email !== undefined && row.email === email) matchedOn.push('email');
      if (phone !== undefined && row.phone === phone) matchedOn.push('phone');

      const name = [
        canReadField(actor, 'lead', 'first_name') ? row.firstName : null,
        canReadField(actor, 'lead', 'last_name') ? row.lastName : null,
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(' ');

      return {
        objectType: 'lead',
        id: row.id,
        label: name.length > 0 ? name : 'Lead',
        matchedOn,
      };
    });
  }

  /**
   * The contact a lead becomes (ADR-0022).
   *
   * Copies exactly the fields in `LEAD_TO_CONTACT_FIELDS`, plus custom fields
   * that exist on both objects with the same key and type. A value is copied
   * only if the actor may read it on the lead **and** write it on the contact:
   * conversion must not be a way to move a value into a field the actor could
   * not have written, or to expose one they could not read. What is left
   * behind is reported in `skipped`, never dropped quietly.
   *
   * The surname is the exception. A contact needs one, so if the actor cannot
   * carry it across the conversion fails rather than inventing a name.
   */
  private mapToContact(
    actor: Actor,
    lead: LeadRow,
    leadFields: readonly FieldDefinition[],
    contactFields: readonly FieldDefinition[],
    skipped: string[],
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    const record = lead as unknown as Record<string, unknown>;

    for (const mapping of LEAD_TO_CONTACT_FIELDS) {
      const value = record[mapping.lead.prop];
      const readable = canReadField(actor, 'lead', mapping.lead.field);
      const writable = canWriteField(actor, 'contact', mapping.contact.field);

      if (mapping.required) {
        if (!readable || !writable) {
          throw new ValidationError([
            {
              path: mapping.contact.prop,
              message: 'You cannot convert a lead whose name you cannot read and copy',
            },
          ]);
        }
        input[mapping.contact.prop] = value;
        continue;
      }

      if (value === null || value === undefined) continue;
      if (!readable || !writable) {
        skipped.push(`contact.${mapping.contact.field}`);
        continue;
      }
      input[mapping.contact.prop] = value;
    }

    const custom: Record<string, unknown> = {};
    for (const source of leadFields) {
      if (source.isSystem || !source.isActive) continue;
      const value = lead.customFields[source.key];
      if (value === null || value === undefined) continue;

      const target = contactFields.find(
        (field) =>
          field.key === source.key &&
          field.type === source.type &&
          !field.isSystem &&
          field.isActive,
      );
      if (target === undefined) continue;

      if (
        !canReadField(actor, 'lead', source.key) ||
        !canWriteField(actor, 'contact', target.key)
      ) {
        skipped.push(`contact.${target.key}`);
        continue;
      }
      custom[target.key] = value;
    }
    if (Object.keys(custom).length > 0) input['customFields'] = custom;

    return input;
  }

  /**
   * Who owns a record the conversion creates.
   *
   * The lead's owner, so a lead worked by one rep does not become a customer
   * owned by whoever pressed the button — but only where the actor could have
   * assigned it themselves. Assigning to somebody else is a reassignment, which
   * needs `all` scope on the target (CLAUDE.md §5.2); otherwise the record is
   * the actor's own, and the conversion is not refused over it.
   */
  private ownerForTarget(actor: Actor, lead: LeadRow, target: ObjectType): string | undefined {
    if (lead.ownerId === null || lead.ownerId === actor.userId) return undefined;
    const decision = can(actor, 'update', { objectType: target });
    return decision.allowed && decision.scope === 'all' ? lead.ownerId : undefined;
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
    const decision = can(actor, 'update', { objectType: 'lead' });
    if (!decision.allowed || decision.scope !== 'all') {
      throw new ValidationError([
        { path: 'ownerId', message: 'You cannot assign records to another user' },
      ]);
    }
    return requestedOwnerId;
  }

  private buildPatch(
    actor: Actor,
    input: LeadUpdateInput,
    existing: LeadRow,
    fields: readonly FieldDefinition[],
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    for (const key of [
      'firstName',
      'lastName',
      'company',
      'email',
      'phone',
      'source',
      'status',
    ] as const) {
      if (key in input) patch[key] = input[key] ?? null;
    }
    // `status` is NOT NULL: clearing it is not a thing a PATCH can mean.
    if (patch['status'] === null) delete patch['status'];

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

function alreadyConverted(): ConflictError {
  return new ConflictError('This lead has already been converted and can no longer be changed', [
    { path: 'status', message: 'Lead is already converted' },
  ]);
}

/**
 * Turn matches into the 409 that makes the client show them.
 *
 * One detail per match: the id the client links to, and why it matched. The
 * label is the one `findDuplicates` built from fields the actor may read.
 */
function duplicateFound(
  matches: readonly { readonly path: 'contact' | 'account'; readonly match: DuplicateMatch }[],
): DuplicateRecordsError {
  return new DuplicateRecordsError(
    matches.map(({ path, match }) => ({
      path,
      message: `Matches existing ${match.objectType} "${match.label}"`,
      meta: { id: match.id, matchedOn: match.matchedOn.join(',') },
    })),
  );
}

function defaultDealName(company: string | null, lastName: string): string {
  return `${company ?? lastName} — opportunity`.slice(0, MAX_DEAL_NAME);
}
