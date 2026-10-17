import { z } from 'zod';
import { listQuerySchema } from './pagination.js';

/**
 * Activity API contracts (ADR-0007, MVP_SPEC §M6).
 *
 * Shared by the API and the web app so request validation and form validation
 * cannot drift. Every object is `.strict()`: an unknown key is a 422, never
 * something to drop quietly (CLAUDE.md §5.6).
 *
 * What a client may **not** send is as deliberate as what it may:
 *
 *   - `completedAt` is absent. A task is completed with
 *     `PATCH { status: 'completed' }` and the server stamps the time, so the
 *     two can never disagree — the database refuses a row where they do.
 *   - `reminderAt` is absent. A client says how far *before* the due date it
 *     wants the reminder and the server derives the instant, so moving a due
 *     date moves its reminder rather than leaving a stale one behind
 *     (ADR-0025).
 *   - `body` is sanitized server-side on the way in and on the way out
 *     (ADR-0024). The schema caps its length; it does not and cannot decide
 *     what markup is safe.
 */

export const activityTypeSchema = z.enum(['task', 'call', 'meeting', 'note']);
export type ActivityTypeInput = z.infer<typeof activityTypeSchema>;

export const activityPrioritySchema = z.enum(['low', 'normal', 'high']);
export const activityStatusSchema = z.enum(['open', 'completed', 'cancelled']);

/**
 * What an activity may be attached to (ADR-0005).
 *
 * The same closed set as `LINK_TARGET_TYPES` in `@crm/core` and the CHECK
 * constraint on `activity_links`. It arrives from a client and ends up next
 * to SQL, so it is validated at all three layers rather than trusted at any
 * of them (CLAUDE.md §5.7).
 */
export const linkTargetTypeSchema = z.enum(['account', 'contact', 'lead', 'deal']);
export type LinkTargetTypeInput = z.infer<typeof linkTargetTypeSchema>;

export const activityLinkSchema = z
  .object({
    objectType: linkTargetTypeSchema,
    recordId: z.uuid(),
  })
  .strict();

export type ActivityLinkInput = z.infer<typeof activityLinkSchema>;

/** Values for custom fields. Shape only here; meaning comes from metadata. */
const customFieldsSchema = z.record(z.string(), z.unknown());

/** The cap the sanitizer and the column agree on (`MAX_RICH_TEXT_LENGTH`). */
export const MAX_ACTIVITY_BODY_LENGTH = 32_000;

/** How far before the due time a reminder may be asked for: up to a week. */
export const MAX_REMINDER_LEAD_MINUTES = 7 * 24 * 60;

/**
 * A handful, not a hundred.
 *
 * Each link is a record the server must check the caller may read, so an
 * unbounded list is an unbounded amount of work for one request — and a
 * meeting about forty records is not a thing anybody does.
 */
export const MAX_ACTIVITY_LINKS = 10;

export const activityCreateSchema = z
  .object({
    type: activityTypeSchema,
    subject: z.string().trim().min(1).max(200),
    body: z.string().max(MAX_ACTIVITY_BODY_LENGTH).nullish(),
    dueAt: z.iso.datetime({ offset: true }).nullish(),
    priority: activityPrioritySchema.optional(),
    /** A call or meeting can be logged as already done. */
    status: activityStatusSchema.optional(),
    reminderMinutesBefore: z.coerce.number().int().min(0).max(MAX_REMINDER_LEAD_MINUTES).optional(),
    /**
     * Omitted means "assign to me". Naming somebody else is a reassignment and
     * needs the scope for it — the server never trusts this value alone
     * (CLAUDE.md §5.2).
     */
    assignedTo: z.uuid().nullish(),
    links: z.array(activityLinkSchema).max(MAX_ACTIVITY_LINKS).optional(),
    customFields: customFieldsSchema.optional(),
  })
  .strict();

export type ActivityCreateInput = z.infer<typeof activityCreateSchema>;

/**
 * PATCH body. Every field optional, but `version` is required, so an edit is
 * never last-write-wins.
 *
 * `links` is absent: attaching and detaching are their own endpoints, because
 * each one is a permission decision about a different record and a whole-list
 * replacement hides which of them was actually meant.
 */
export const activityUpdateSchema = activityCreateSchema
  .omit({ links: true })
  .partial()
  .extend({ version: z.coerce.number().int().positive() })
  .strict();

export type ActivityUpdateInput = z.infer<typeof activityUpdateSchema>;

/** One resolved link, as the API returns it. */
export const activityLinkViewSchema = z.object({
  objectType: linkTargetTypeSchema,
  recordId: z.uuid(),
  /** Built from fields the caller may read; absent when they may read none. */
  label: z.string(),
});

export type ActivityLinkView = z.infer<typeof activityLinkViewSchema>;

/**
 * What the API returns. Fields the caller may not read are stripped by the
 * serializer first, so the schema describes the maximum, not a guarantee.
 */
export const activitySchema = z.object({
  id: z.uuid(),
  type: activityTypeSchema.optional(),
  subject: z.string().optional(),
  body: z.string().nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: activityPrioritySchema.optional(),
  status: activityStatusSchema.optional(),
  assignedTo: z.uuid().nullable().optional(),
  /** Only the links whose target the caller may read (ADR-0005). */
  links: z.array(activityLinkViewSchema).optional(),
  customFields: customFieldsSchema.optional(),
  version: z.number().int().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type Activity = z.infer<typeof activitySchema>;

/**
 * List query.
 *
 * `objectType` + `recordId` ask for "the activities on this record", which is
 * how a record page reads its list. Both or neither: half of a polymorphic
 * pair identifies nothing.
 */
export const activityListQuerySchema = listQuerySchema
  .extend({
    objectType: linkTargetTypeSchema.optional(),
    recordId: z.uuid().optional(),
    status: activityStatusSchema.optional(),
    assignedTo: z.uuid().optional(),
  })
  .strict()
  .refine((query) => (query.objectType === undefined) === (query.recordId === undefined), {
    message: 'objectType and recordId must be given together',
    path: ['recordId'],
  });

export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export const activityParamsSchema = z.object({ id: z.uuid() }).strict();

/** DELETE carries the version for the same reason PATCH does. */
export const activityDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type ActivityDeleteQuery = z.infer<typeof activityDeleteQuerySchema>;

/** Detaching names the pair rather than a link id: it is the natural key. */
export const activityUnlinkQuerySchema = activityLinkSchema;

// ---------------------------------------------------------------------------
// My Day (MVP_SPEC M6)
// ---------------------------------------------------------------------------

/**
 * `timeZone` is the viewer's IANA zone.
 *
 * Optional: the server falls back to the zone on the user's profile. It is
 * accepted from the client because a browser knows where it is and a profile
 * can be stale, and because it decides nothing but which day boundaries this
 * one person's own list is cut on. It is validated against the runtime's IANA
 * database before use — an unknown zone is a 422, never a silent fall back to
 * UTC, which would quietly shift everybody's tasks by a day.
 */
export const myDayQuerySchema = z
  .object({
    timeZone: z.string().min(1).max(64).optional(),
    /** Defaults to today in that zone. Mostly here so tests are deterministic. */
    date: z.iso.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type MyDayQuery = z.infer<typeof myDayQuerySchema>;

export const recentlyViewedItemSchema = z.object({
  objectType: linkTargetTypeSchema,
  recordId: z.uuid(),
  label: z.string(),
  viewedAt: z.iso.datetime({ offset: true }),
});

export type RecentlyViewedItem = z.infer<typeof recentlyViewedItemSchema>;

export const myDaySchema = z.object({
  /** The calendar date the buckets were cut on, as the viewer sees it. */
  date: z.iso.date(),
  timeZone: z.string(),
  overdue: z.array(activitySchema),
  dueToday: z.array(activitySchema),
  upcoming: z.array(activitySchema),
  recentlyViewed: z.array(recentlyViewedItemSchema),
});

export type MyDay = z.infer<typeof myDaySchema>;

/** "I opened this record." Checked against what the caller may read. */
export const recordViewCreateSchema = activityLinkSchema;
export type RecordViewCreateInput = z.infer<typeof recordViewCreateSchema>;
