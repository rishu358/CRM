import { accountCreateSchema, contactCreateSchema, leadCreateSchema } from '@crm/contracts';
import {
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  can,
  canWriteField,
  coerceCell,
  diffChanges,
  IMPORT_LINK_KEYS,
  IMPORTABLE_SYSTEM_KEYS,
  newId,
  type Actor,
  type FieldDefinition,
  type ImportableObjectType,
  type ObjectType,
} from '@crm/core';
import {
  auditLogs,
  constraintToSql,
  OBJECT_DESCRIPTORS,
  outboxEvents,
  recordRefFor,
  type RecordRow,
  type Tx,
} from '@crm/db';
import { linkValueKey, resolveLinks, type LinkCell } from './import-links.js';

/**
 * Turn one chunk of staged rows into records (MVP_SPEC §M8, ADR-0029).
 *
 * This is the bulk-write path, and "what can an import do that a normal write
 * cannot" is the question it is built around. The answers it gives:
 *
 *   - **It writes only fields the actor may write, row by row.** The mapping
 *     was checked when the job started and is checked again before every
 *     chunk, but a mapped column is still run through `canWriteField` per
 *     field here, so a mistake in either earlier check cannot become a write.
 *   - **It cannot set `tenant_id`, `version` or an id.** Those are not in
 *     `IMPORTABLE_SYSTEM_KEYS`, so no mapped column can reach them, and the
 *     values are set below from the actor and the job, never from a cell.
 *   - **The owner and a contact's account come from a cell only through
 *     `import-links.ts`** (ADR-0067): named by e-mail address, name or domain,
 *     looked up inside the actor's own reach, and refused unless the actor may
 *     reassign records of that kind. Otherwise the importer owns every row.
 *   - **Every system value goes through the same Zod schema the API's create
 *     endpoint uses** (`contactCreateSchema` and friends), so an import cannot
 *     hold a looser definition of a valid email, phone, domain or GSTIN than a
 *     form does. Custom fields go through the schema generated from this
 *     tenant's metadata, exactly as in the services.
 *   - **Matching only sees what the actor may see.** A duplicate in a
 *     colleague's book is not a match, so `update` cannot touch it and `skip`
 *     cannot be used to learn it exists — it is simply not seen, and the row
 *     is created (ADR-0023 makes the same choice for lead duplicate checks).
 *   - **Every record gets its audit entry and outbox event**, written in the
 *     same transaction as the record, like any other write (CLAUDE.md §5.10).
 *
 * Failures are per row. A bad row is recorded and the chunk carries on; only
 * the chunk as a whole is all-or-nothing, which is what makes a retry safe.
 */

export interface ChunkRow {
  readonly rowNumber: number;
  /** The row in the user's own spreadsheet. Errors name this one. */
  readonly sourceRow: number;
  readonly cells: readonly string[];
}

export interface RowError {
  readonly sourceRow: number;
  readonly rowNumber: number;
  readonly field: string | null;
  readonly message: string;
}

export interface ChunkResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly errors: readonly RowError[];
}

export interface ChunkContext {
  readonly actor: Actor;
  readonly jobId: string;
  readonly objectType: ImportableObjectType;
  readonly fields: readonly FieldDefinition[];
  readonly mapping: readonly { readonly column: number; readonly field: string }[];
  readonly duplicateMode: 'skip' | 'update' | 'create';
  readonly matchField: string | null;
}

const SCHEMAS = {
  contact: { create: contactCreateSchema, partial: contactCreateSchema.partial() },
  account: { create: accountCreateSchema, partial: accountCreateSchema.partial() },
  lead: { create: leadCreateSchema, partial: leadCreateSchema.partial() },
} as const;

const LINK_LABELS: Readonly<Record<string, string>> = { owner_id: 'Owner', account_id: 'Account' };
const linkLabel = (key: string): string => LINK_LABELS[key] ?? key;

const snakeToCamel = (key: string): string =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

interface ParsedRow {
  readonly row: ChunkRow;
  /** Validated system values, by their API (camelCase) key. */
  system: Record<string, unknown>;
  custom: Record<string, unknown>;
  /** Field keys this row actually supplied (a blank cell supplies nothing). */
  supplied: string[];
  /** Link columns (owner, account) as typed, resolved to ids after parsing. */
  links: LinkCell[];
  errors: { field: string | null; message: string }[];
}

interface PendingCreate {
  readonly parsed: ParsedRow;
  readonly id: string;
  readonly values: Record<string, unknown>;
}

function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  labelFor: (head: string) => { field: string; label: string } | null,
): { field: string | null; message: string }[] {
  return issues.map((issue) => {
    const head = String(issue.path[0] ?? '');
    const known = labelFor(head);
    return known === null
      ? { field: null, message: issue.message }
      : { field: known.field, message: `${known.label}: ${issue.message}` };
  });
}

export async function processChunk(
  tx: Tx,
  context: ChunkContext,
  rows: readonly ChunkRow[],
): Promise<ChunkResult> {
  const { actor, objectType } = context;
  const descriptor = OBJECT_DESCRIPTORS[objectType];
  const schemas = SCHEMAS[objectType];
  const object = objectType as ObjectType;

  const definitions = new Map(
    context.fields.filter((field) => field.isActive).map((field) => [field.key, field]),
  );
  const customDefinitions = context.fields.filter((field) => field.isActive && !field.isSystem);
  const labelByCamel = new Map<string, { field: string; label: string }>();
  for (const entry of context.mapping) {
    const definition = definitions.get(entry.field);
    if (definition !== undefined) {
      labelByCamel.set(snakeToCamel(entry.field), { field: entry.field, label: definition.label });
    }
  }
  const labelFor = (head: string) =>
    labelByCamel.get(head) ??
    (definitions.has(head) ? { field: head, label: definitions.get(head)?.label ?? head } : null);

  const customSchema = buildCustomFieldsSchema(customDefinitions);
  const customPatchSchema = buildCustomFieldsPatchSchema(customDefinitions);

  const errors: RowError[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  const fail = (parsed: ParsedRow): void => {
    failed += 1;
    for (const error of parsed.errors) {
      errors.push({
        sourceRow: parsed.row.sourceRow,
        rowNumber: parsed.row.rowNumber,
        field: error.field,
        message: error.message,
      });
    }
  };

  // -------------------------------------------------------------------------
  // 1. Parse and validate every row. Nothing is written yet.
  // -------------------------------------------------------------------------
  const parsedRows: ParsedRow[] = rows.map((row) => {
    const parsed: ParsedRow = {
      row,
      system: {},
      custom: {},
      supplied: [],
      links: [],
      errors: [],
    };

    for (const entry of context.mapping) {
      // A link column (owner, account) is not a typed value: it is looked up after parsing.
      if (IMPORT_LINK_KEYS[objectType].includes(entry.field)) {
        const text = (row.cells[entry.column] ?? '').trim();
        if (text === '') continue;
        if (!canWriteField(actor, object, entry.field)) {
          parsed.errors.push({
            field: entry.field,
            message: `${linkLabel(entry.field)}: you do not have permission to write this field`,
          });
          continue;
        }
        parsed.supplied.push(entry.field);
        parsed.links.push({ key: entry.field, value: text });
        continue;
      }

      const definition = definitions.get(entry.field);
      if (definition === undefined) {
        parsed.errors.push({ field: entry.field, message: 'This field is no longer available' });
        continue;
      }
      // Not importable, whatever the actor may write: `owner_id` and anything
      // else off the allowlist. The mapping check already refuses these; this is
      // the same rule again at the write, because an *update* patch built from a
      // mapped `owner_id` would silently reassign a record.
      if (definition.isSystem && !IMPORTABLE_SYSTEM_KEYS[objectType].includes(entry.field)) {
        parsed.errors.push({
          field: entry.field,
          message: `${definition.label}: this field cannot be set by an import`,
        });
        continue;
      }
      const cell = coerceCell(definition, row.cells[entry.column] ?? '');
      // A blank cell supplies nothing, so it writes nothing and needs no
      // permission. Only a *value* is held to the actor's field permissions.
      if (cell.ok && 'blank' in cell) continue;

      // The per-row field-permission check (CLAUDE.md §5.4). The mapping was
      // validated against the same rule; this is the rule again, at the write.
      if (!canWriteField(actor, object, entry.field)) {
        parsed.errors.push({
          field: entry.field,
          message: `${definition.label}: you do not have permission to write this field`,
        });
        continue;
      }
      if (!cell.ok) {
        parsed.errors.push({ field: entry.field, message: `${definition.label}: ${cell.message}` });
        continue;
      }

      parsed.supplied.push(entry.field);
      if (definition.isSystem) parsed.system[snakeToCamel(entry.field)] = cell.value;
      else parsed.custom[entry.field] = cell.value;
    }

    if (parsed.errors.length > 0) return parsed;

    // The partial schemas normalise (lower-case an email, strip a domain's case)
    // and reject malformed values. Whether a *required* value is present is
    // decided later, once we know whether this row creates or updates.
    const system = schemas.partial.safeParse(parsed.system);
    if (!system.success) {
      parsed.errors.push(...formatIssues(system.error.issues, labelFor));
    } else {
      parsed.system = system.data;
    }

    const custom = customPatchSchema.safeParse(parsed.custom);
    if (!custom.success) {
      parsed.errors.push(...formatIssues(custom.error.issues, labelFor));
    } else {
      parsed.custom = custom.data;
    }
    return parsed;
  });

  // Turn the owner and account cells into ids, once for the whole chunk.
  const linkCells = parsedRows
    .filter((parsed) => parsed.errors.length === 0)
    .flatMap((parsed) => parsed.links);
  if (linkCells.length > 0) {
    const resolution = await resolveLinks(tx, actor, objectType, linkCells);
    for (const parsed of parsedRows) {
      if (parsed.errors.length > 0) continue;
      for (const link of parsed.links) {
        const value = linkValueKey(link.key, link.value);
        const problem = resolution.problems.get(link.key)?.get(value);
        const id = resolution.ids.get(link.key)?.get(value);
        if (problem !== undefined || id === undefined) {
          parsed.errors.push({
            field: link.key,
            message: problem ?? `${linkLabel(link.key)}: not found`,
          });
        } else {
          parsed.system[snakeToCamel(link.key)] = id;
        }
      }
    }
  }

  const valid = parsedRows.filter((parsed) => parsed.errors.length === 0);
  for (const parsed of parsedRows) if (parsed.errors.length > 0) fail(parsed);

  // -------------------------------------------------------------------------
  // 2. Find existing records to match, inside the actor's own visibility.
  // -------------------------------------------------------------------------
  const matchKey = context.duplicateMode === 'create' ? null : context.matchField;
  const matchCamel = matchKey === null ? null : snakeToCamel(matchKey);

  const existing = new Map<string, RecordRow[]>();
  if (matchKey !== null && matchCamel !== null) {
    const read = can(actor, 'read', { objectType: object });
    if (read.allowed) {
      const values = [
        ...new Set(
          valid
            .map((parsed) => parsed.system[matchCamel])
            .filter((value): value is string => typeof value === 'string' && value !== ''),
        ),
      ];
      const scope = constraintToSql(read.constraint, descriptor.ownerId);
      const found = await descriptor.selectByMatch(tx, {
        tenantId: actor.tenantId,
        matchExpression: descriptor.matchExpression(matchKey),
        values,
        ...(scope === undefined ? {} : { scope }),
      });
      for (const record of found) {
        const raw = record[matchCamel];
        const key = typeof raw === 'string' ? raw : '';
        existing.set(key, [...(existing.get(key) ?? []), record]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Decide each row: create, update, skip or fail.
  // -------------------------------------------------------------------------
  const creates: PendingCreate[] = [];
  const pendingByKey = new Map<string, PendingCreate>();
  const updates: {
    parsed: ParsedRow;
    record: RecordRow;
    patch: Record<string, unknown>;
  }[] = [];

  const requiredMissing = (parsed: ParsedRow): void => {
    for (const entry of context.mapping) {
      const definition = definitions.get(entry.field);
      if (definition?.required === true && !parsed.supplied.includes(entry.field)) {
        parsed.errors.push({ field: entry.field, message: `${definition.label} is required` });
      }
    }
  };

  for (const parsed of valid) {
    const value = matchCamel === null ? undefined : parsed.system[matchCamel];
    const key = typeof value === 'string' && value !== '' ? value : null;

    // A row that repeats a value an earlier row in this chunk created.
    const pending = key === null ? undefined : pendingByKey.get(key);
    if (pending !== undefined) {
      if (context.duplicateMode === 'update') {
        // Fold the later row into the record the earlier one is about to create:
        // the result is what two sequential rows would have produced.
        Object.assign(pending.values, parsed.system);
        pending.values['customFields'] = {
          ...(pending.values['customFields'] as Record<string, unknown>),
          ...parsed.custom,
        };
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const matches = key === null ? [] : (existing.get(key) ?? []);

    if (context.duplicateMode === 'skip' && matches.length > 0) {
      skipped += 1;
      continue;
    }

    if (context.duplicateMode === 'update' && matches.length > 1) {
      parsed.errors.push({
        field: matchKey,
        message: `This row matches ${matches.length} existing records; it was not updated because it is unclear which is meant`,
      });
      fail(parsed);
      continue;
    }

    if (context.duplicateMode === 'update' && matches.length === 1) {
      const record = matches[0] as RecordRow;
      const decision = can(actor, 'update', {
        objectType: object,
        record: await recordRefFor(tx, actor, (record['ownerId'] as string | null) ?? null),
      });
      if (!decision.allowed) {
        parsed.errors.push({
          field: null,
          message: 'You do not have permission to update the matching record',
        });
        fail(parsed);
        continue;
      }

      const patch: Record<string, unknown> = {};
      for (const [camel, next] of Object.entries(parsed.system)) {
        if (JSON.stringify(record[camel] ?? null) !== JSON.stringify(next ?? null)) {
          patch[camel] = next;
        }
      }
      if (Object.keys(parsed.custom).length > 0) {
        // Merge, never replace: a row naming one custom field must not wipe the
        // others the file never mentioned.
        const merged = {
          ...((record['customFields'] as Record<string, unknown> | undefined) ?? {}),
          ...parsed.custom,
        };
        if (JSON.stringify(merged) !== JSON.stringify(record['customFields'] ?? {})) {
          patch['customFields'] = merged;
        }
      }
      if (Object.keys(patch).length === 0) {
        skipped += 1; // Nothing would change; do not bump a version for it.
        continue;
      }
      updates.push({ parsed, record, patch });
      continue;
    }

    // A new record. Required values are only demanded here: a row that updates
    // an existing record is allowed to name just the fields it changes.
    requiredMissing(parsed);
    if (parsed.errors.length === 0) {
      const create = schemas.create.safeParse(parsed.system);
      if (!create.success) parsed.errors.push(...formatIssues(create.error.issues, labelFor));
      const custom = customSchema.safeParse(parsed.custom);
      if (!custom.success) parsed.errors.push(...formatIssues(custom.error.issues, labelFor));
    }
    if (parsed.errors.length > 0) {
      fail(parsed);
      continue;
    }

    const id = newId();
    const values: Record<string, unknown> = {
      ...parsed.system,
      id,
      tenantId: actor.tenantId,
      // The importer, unless the file named an owner the importer may hand records to.
      ownerId:
        typeof parsed.system['ownerId'] === 'string' ? parsed.system['ownerId'] : actor.userId,
      customFields: parsed.custom,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    };
    const create: PendingCreate = { parsed, id, values };
    creates.push(create);
    if (key !== null) pendingByKey.set(key, create);
  }

  // -------------------------------------------------------------------------
  // 4. Write. Inserts in one statement with a per-row fallback; updates one by
  //    one, each behind a savepoint so one bad row cannot poison the chunk.
  // -------------------------------------------------------------------------
  const auditRows: (typeof auditLogs.$inferInsert)[] = [];
  const outboxRows: (typeof outboxEvents.$inferInsert)[] = [];

  const record = (
    action: 'create' | 'update',
    recordId: string,
    changes: Record<string, { old?: unknown; new?: unknown }>,
    ownerId: unknown,
  ): void => {
    auditRows.push({
      id: newId(),
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action,
      objectType,
      recordId,
      // The job id ties every record back to the import that made it.
      changes: { ...changes, importJobId: { new: context.jobId } },
    });
    outboxRows.push({
      id: newId(),
      tenantId: actor.tenantId,
      eventType: `${objectType}.${action === 'create' ? 'created' : 'updated'}.v1`,
      objectType,
      recordId,
      payload:
        action === 'create'
          ? { ownerId: ownerId ?? null }
          : { changedFields: Object.keys(changes) },
      actorId: actor.userId,
    });
  };

  const inserted = await insertCreates(tx, objectType, creates);
  for (const create of creates) {
    if (inserted.has(create.id)) {
      created += 1;
      record('create', create.id, identityChanges(objectType, create.values), actor.userId);
    } else {
      create.parsed.errors.push({ field: null, message: 'The record could not be saved' });
      fail(create.parsed);
    }
  }

  for (const { parsed, record: existingRecord, patch } of updates) {
    let result: RecordRow | null;
    try {
      result = await tx.transaction((savepoint) =>
        descriptor.updateOne(savepoint, {
          tenantId: actor.tenantId,
          id: existingRecord['id'] as string,
          expectedVersion: existingRecord['version'] as number,
          patch: { ...patch, updatedBy: actor.userId },
        }),
      );
    } catch {
      result = null;
    }
    if (result === null) {
      parsed.errors.push({
        field: null,
        message: 'The record was changed by someone else; it was not updated',
      });
      fail(parsed);
      continue;
    }
    updated += 1;
    record(
      'update',
      existingRecord['id'] as string,
      diffChanges(existingRecord, patch),
      existingRecord['ownerId'],
    );
  }

  if (auditRows.length > 0) await tx.insert(auditLogs).values(auditRows);
  if (outboxRows.length > 0) await tx.insert(outboxEvents).values(outboxRows);

  return { created, updated, skipped, failed, errors };
}

/** The fields an audit `create` entry carries, matching what each service records. */
function identityChanges(
  objectType: ImportableObjectType,
  values: Record<string, unknown>,
): Record<string, { old?: unknown; new?: unknown }> {
  const pick: Record<ImportableObjectType, readonly string[]> = {
    contact: ['lastName', 'email', 'accountId', 'ownerId'],
    account: ['name', 'domain', 'ownerId'],
    lead: ['lastName', 'company', 'email', 'status', 'ownerId'],
  };
  return diffChanges(
    {},
    Object.fromEntries(pick[objectType].map((key) => [key, values[key] ?? null])),
  );
}

/**
 * Insert in one statement; if the database rejects the batch, retry row by row
 * so one bad row costs one error line and not 500.
 *
 * Each attempt is its own savepoint. Without that, the first rejected statement
 * would leave the whole transaction in Postgres's aborted state and every
 * later statement in the chunk would fail with it.
 */
async function insertCreates(
  tx: Tx,
  objectType: ImportableObjectType,
  creates: readonly PendingCreate[],
): Promise<Set<string>> {
  const descriptor = OBJECT_DESCRIPTORS[objectType];
  if (creates.length === 0) return new Set();

  try {
    await tx.transaction((savepoint) =>
      descriptor.insertMany(
        savepoint,
        creates.map((create) => create.values),
      ),
    );
    return new Set(creates.map((create) => create.id));
  } catch {
    const ok = new Set<string>();
    for (const create of creates) {
      try {
        await tx.transaction((savepoint) => descriptor.insertMany(savepoint, [create.values]));
        ok.add(create.id);
      } catch {
        // Recorded by the caller as a failed row. Never echo the driver's
        // message: it can contain the offending value.
      }
    }
    return ok;
  }
}
