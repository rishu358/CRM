import { z } from 'zod';
import { moneySchema } from './accounts.js';
import { activitySchema } from './activities.js';

/**
 * The home dashboard (MVP_SPEC M10, ADR-0038).
 *
 * One endpoint per widget, not one for the page. A caller may be allowed to read
 * deals and not leads, and one slow or refused widget must not blank the others;
 * each is authorized against the object it summarises and fails alone.
 *
 * ## "Not available" is a value, not a zero
 *
 * A total is the amounts, a source breakdown is the sources, an overdue count is
 * the due dates. A caller whose field permissions hide `amount`, `source` or
 * `due_at` must not be able to read them back as a sum or a count, so the widget
 * answers `null` for exactly the part that cannot be shown, and the screen says
 * "not available to you" rather than drawing a zero that looks like a fact.
 * Counts that do not depend on the hidden field (how many deals sit in a stage)
 * are still given, as the board already does.
 *
 * Nothing here takes a tenant or a user. Both come from the session; a query
 * carrying one is a 422 because every object is `.strict()` (CLAUDE.md §5.2, §5.6).
 */

const unconvertedSchema = z.array(
  z.object({ currency: z.string(), count: z.number().int(), amountMinor: z.string() }),
);

/** A total in the tenant's currency, plus whatever had no exchange rate (ADR-0021). */
const totalSchema = z.object({
  count: z.number().int(),
  total: moneySchema.nullable(),
  unconverted: unconvertedSchema,
});

export const dashboardPipelineQuerySchema = z.object({ pipelineId: z.uuid().optional() }).strict();
export type DashboardPipelineQuery = z.infer<typeof dashboardPipelineQuerySchema>;

export const dashboardPipelineSchema = z.object({
  pipelineId: z.uuid(),
  currency: z.string(),
  /** Open stages only, in stage order: won and lost deals are not pipeline. */
  stages: z.array(
    z.object({
      stageId: z.uuid(),
      name: z.string(),
      count: z.number().int(),
      total: moneySchema.nullable(),
      unconverted: unconvertedSchema,
    }),
  ),
  /** Everything still open across those stages. `total` is null if `amount` is hidden. */
  open: totalSchema,
});
export type DashboardPipeline = z.infer<typeof dashboardPipelineSchema>;

/** A calendar month in the company's time zone, as the instants that bound it. */
const monthSchema = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});

export const dashboardWonSchema = z.object({
  currency: z.string(),
  timeZone: z.string(),
  month: monthSchema,
  /** Null when `closed_at` is hidden: "won this month" is a statement about it. */
  current: totalSchema.nullable(),
  /** The month before, to say whether this one is ahead. Same rule. */
  previous: totalSchema.nullable(),
});
export type DashboardWon = z.infer<typeof dashboardWonSchema>;

export const dashboardLeadsBySourceSchema = z.object({
  /** Open leads: every current lead that is not converted and not deleted. Null when `status` is hidden. */
  total: z.number().int().nullable(),
  /** Null when `source` or `status` is hidden. A lead with no source is the `null` key. */
  sources: z.array(z.object({ source: z.string().nullable(), count: z.number().int() })).nullable(),
  /** Leads in sources beyond the ones listed, so the rows always add up to `total`. */
  otherCount: z.number().int(),
});
export type DashboardLeadsBySource = z.infer<typeof dashboardLeadsBySourceSchema>;

export const dashboardOverdueSchema = z.object({
  /** Null when `type`, `due_at` or `status` is hidden: overdue is derived from them. */
  count: z.number().int().nullable(),
  /** The oldest few, serialized as the activities list would be. */
  items: z.array(activitySchema),
});
export type DashboardOverdue = z.infer<typeof dashboardOverdueSchema>;

export const dashboardLeaderboardSchema = z.object({
  currency: z.string(),
  timeZone: z.string(),
  month: monthSchema,
  /** `count` when `amount` is hidden: ranked by deals won, with no money shown. */
  rankedBy: z.enum(['amount', 'count']),
  /** Null when `closed_at` or `owner_id` is hidden. */
  rows: z
    .array(
      z.object({
        userId: z.uuid(),
        name: z.string(),
        /** Whether this row is the caller, so the screen can say so without knowing who they are. */
        isYou: z.boolean(),
        count: z.number().int(),
        total: moneySchema.nullable(),
        /** True when some of this person's deals are in a currency with no rate, so the total is short. */
        partial: z.boolean(),
      }),
    )
    .nullable(),
});
export type DashboardLeaderboard = z.infer<typeof dashboardLeaderboardSchema>;
