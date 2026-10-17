import { z } from 'zod';
import { moneySchema } from './accounts.js';
import { listQuerySchema } from './pagination.js';

/**
 * Deal and pipeline API contracts (ADR-0007).
 *
 * Shared by the API and the web app, so request validation and form
 * validation cannot drift. Every object is `.strict()`: an unknown key is a
 * 422, never something to drop quietly (CLAUDE.md §5.6).
 *
 * What a client may **not** send is as deliberate as what it may. `closedAt`
 * is absent from the write schemas because it is a consequence of the stage,
 * not an input: letting a client set it would let a deal be "won" with no
 * stage change, or sit in a won stage still open. The stage decides it
 * (ADR-0020), so the only way to close a deal through the API is to move it.
 */

/** Values for custom fields. Shape only here; meaning comes from metadata. */
const customFieldsSchema = z.record(z.string(), z.unknown());

/** A person on a deal, and what they are to it ("decision maker", "buyer"). */
export const dealContactInputSchema = z
  .object({
    contactId: z.uuid(),
    role: z.string().trim().min(1).max(80).nullish(),
  })
  .strict();

export type DealContactInput = z.infer<typeof dealContactInputSchema>;

/** More than this on one deal is a data-entry accident, not a buying committee. */
export const MAX_DEAL_CONTACTS = 50;

export const dealCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    accountId: z.uuid().nullish(),
    primaryContactId: z.uuid().nullish(),
    /**
     * Omitted means "the tenant's default pipeline". The stage must belong to
     * whichever pipeline results; that is settled by the service and, below
     * it, by a composite foreign key.
     */
    pipelineId: z.uuid().optional(),
    /** Omitted means "the first open stage of the pipeline". */
    stageId: z.uuid().optional(),
    amount: moneySchema.nullish(),
    /**
     * Only meaningful in an open stage. A closed stage fixes the probability
     * (100 for won, 0 for lost), so sending one there is a 422 rather than a
     * value that is quietly overridden.
     */
    probability: z.number().int().min(0).max(100).optional(),
    /** A calendar date, `YYYY-MM-DD`. */
    expectedCloseDate: z.iso.date().nullish(),
    /** Required when the deal is in a lost stage, refused when it is not. */
    lostReason: z.string().trim().min(1).max(500).nullish(),
    /**
     * Omitted means "assign to me". A client may name another owner only if
     * `can()` permits reassignment — the server never trusts this value alone
     * (CLAUDE.md §5.2).
     */
    ownerId: z.uuid().nullish(),
    /** The people on the deal. On update, replaces the whole set. */
    contacts: z.array(dealContactInputSchema).max(MAX_DEAL_CONTACTS).optional(),
    customFields: customFieldsSchema.optional(),
  })
  .strict();

export type DealCreateInput = z.infer<typeof dealCreateSchema>;

/**
 * PATCH body. Every field optional, but `version` is required.
 *
 * Without the version an edit — and above all a drag on the board — would be
 * last-write-wins, and two reps moving the same card would silently overwrite
 * each other. A stale version is a 409, not a clobber.
 */
export const dealUpdateSchema = dealCreateSchema
  .partial()
  .extend({
    version: z.coerce.number().int().positive(),
  })
  .strict();

export type DealUpdateInput = z.infer<typeof dealUpdateSchema>;

export const stageTypeSchema = z.enum(['open', 'won', 'lost']);
export type StageType = z.infer<typeof stageTypeSchema>;

export const dealContactSchema = z.object({
  contactId: z.uuid(),
  role: z.string().nullable(),
});

/**
 * What the API returns.
 *
 * Fields the caller may not read are stripped by the serializer before this is
 * built, so a response legitimately may not contain every key here — the
 * schema describes the maximum, not a guarantee.
 */
export const dealSchema = z.object({
  id: z.uuid(),
  name: z.string().optional(),
  accountId: z.uuid().nullable().optional(),
  primaryContactId: z.uuid().nullable().optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  amount: moneySchema.nullable().optional(),
  probability: z.number().int().optional(),
  expectedCloseDate: z.iso.date().nullable().optional(),
  closedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  lostReason: z.string().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  contacts: z.array(dealContactSchema).optional(),
  customFields: customFieldsSchema.optional(),
  version: z.number().int().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type Deal = z.infer<typeof dealSchema>;

export const stageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  probability: z.number().int(),
  stageType: stageTypeSchema,
});

export type Stage = z.infer<typeof stageSchema>;

export const pipelineSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  isDefault: z.boolean(),
  stages: z.array(stageSchema),
});

export type Pipeline = z.infer<typeof pipelineSchema>;

export const dealListQuerySchema = listQuerySchema;
export type DealListQuery = z.infer<typeof dealListQuerySchema>;

/** Path parameter for the single-record routes. */
export const dealParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * DELETE carries the version for the same reason PATCH does: deleting a record
 * somebody else has just edited should fail loudly rather than quietly win.
 */
export const dealDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type DealDeleteQuery = z.infer<typeof dealDeleteQuerySchema>;

/** The board's column totals: which pipeline, and nothing else. */
export const dealBoardQuerySchema = z.object({ pipelineId: z.uuid().optional() }).strict();
export type DealBoardQuery = z.infer<typeof dealBoardQuerySchema>;

/**
 * One column's totals, in the tenant's default currency (ADR-0021).
 *
 * `unconverted` names the currencies that had no rate, so a total is never
 * silently short: a column that omitted a deal because its currency had no
 * rate and said nothing would be a wrong number that looks right.
 */
export const dealBoardColumnSchema = z.object({
  stageId: z.uuid(),
  count: z.number().int(),
  total: moneySchema.nullable(),
  unconverted: z.array(
    z.object({ currency: z.string(), count: z.number().int(), amountMinor: z.string() }),
  ),
});

export type DealBoardColumn = z.infer<typeof dealBoardColumnSchema>;

export const dealBoardSchema = z.object({
  pipelineId: z.uuid(),
  currency: z.string(),
  columns: z.array(dealBoardColumnSchema),
});

export type DealBoard = z.infer<typeof dealBoardSchema>;
