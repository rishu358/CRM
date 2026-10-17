import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  dayWindowFor,
  isPlainDate,
  isTimeZone,
  newId,
  NotFoundError,
  startOfDayIn,
  endOfDayIn,
  upcomingEnd,
  ValidationError,
  type Actor,
  type PlainDate,
  type TimeZone,
} from '@crm/core';
import type { MyDayQuery, RecentlyViewedItem, RecordViewCreateInput } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { ActivitiesRepository } from './activities.repository.js';
import { serializeActivities, type SerializedActivity } from './activities.serializer.js';
import { RecordLinksService, keyFor } from './record-links.service.js';
import { RecordViewsRepository } from './record-views.repository.js';

/**
 * The My Day home screen (MVP_SPEC M6).
 *
 * The one thing this service exists to get right is **whose day it is**.
 * "Overdue", "due today" and "upcoming" are statements about a calendar, and
 * a calendar belongs to a person in a place: 00:30 UTC on Saturday is still
 * Friday evening in Los Angeles and already mid-morning Saturday in Kolkata.
 * Cutting the buckets on UTC midnight would silently move other people's work
 * between days — silently being the problem, since nothing errors and the
 * list is merely wrong.
 *
 * So the day boundaries come from `@crm/core/activities`, which takes an IANA
 * zone, and the repository compares plain instants. There is exactly one
 * place that knows about time zones, and it has its own tests.
 */
const RECENTLY_VIEWED_LIMIT = 10;

/**
 * What the screen returns.
 *
 * The activities are `SerializedActivity`, not the contract's `Activity`:
 * what a caller actually receives depends on their field permissions, so the
 * contract describes the maximum and the serializer decides the rest
 * (CLAUDE.md §5.4).
 */
export interface MyDayResponse {
  readonly date: string;
  readonly timeZone: string;
  readonly overdue: SerializedActivity[];
  readonly dueToday: SerializedActivity[];
  readonly upcoming: SerializedActivity[];
  readonly recentlyViewed: RecentlyViewedItem[];
}

/** How many of a person's views are kept. Enough for the list, plus slack. */
const RECENTLY_VIEWED_KEEP = 50;

@Injectable()
export class MyDayService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ActivitiesRepository) private readonly activities: ActivitiesRepository,
    @Inject(RecordViewsRepository) private readonly views: RecordViewsRepository,
    @Inject(RecordLinksService) private readonly recordLinks: RecordLinksService,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
  ) {}

  async forActor(actor: Actor, query: MyDayQuery): Promise<MyDayResponse> {
    // My Day is my own work, so the scope constraint adds nothing — but the
    // grant still has to exist. A user with no read permission on activities
    // gets 403 here rather than an empty screen that looks like "no tasks".
    assertCan(actor, 'read', { objectType: 'activity' });

    return this.database.runInTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      async (tx) => {
        const timeZone = await this.resolveTimeZone(tx, actor, query.timeZone);
        const window = this.windowFor(timeZone, query.date);
        const limit = query.limit;

        const buckets = await this.activities.myDay(tx, actor.tenantId, {
          assigneeId: actor.userId,
          startOfDay: window.start,
          endOfDay: window.end,
          upcomingEnd: upcomingEnd(window, timeZone),
          limit,
        });

        const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');
        const rows = [...buckets.overdue, ...buckets.dueToday, ...buckets.upcoming];

        // Links are resolved for the whole screen at once, and each one is
        // still filtered to what this reader may see (ADR-0005).
        const linkRows = await this.activities.linksFor(
          tx,
          actor.tenantId,
          rows.map((row) => row.id),
        );
        const resolved = await this.recordLinks.resolveMany(
          tx,
          actor,
          linkRows.map((link) => ({
            objectType: link.objectType as 'account' | 'contact' | 'lead' | 'deal',
            recordId: link.recordId,
          })),
        );
        const linksByActivity = new Map<
          string,
          { objectType: 'account' | 'contact' | 'lead' | 'deal'; recordId: string; label: string }[]
        >();
        for (const link of linkRows) {
          const target = resolved.get(keyFor(link.objectType, link.recordId));
          if (target === undefined) continue;
          const list = linksByActivity.get(link.activityId) ?? [];
          list.push(target);
          linksByActivity.set(link.activityId, list);
        }

        return {
          date: window.date,
          timeZone,
          overdue: serializeActivities(actor, buckets.overdue, fields, linksByActivity),
          dueToday: serializeActivities(actor, buckets.dueToday, fields, linksByActivity),
          upcoming: serializeActivities(actor, buckets.upcoming, fields, linksByActivity),
          recentlyViewed: await this.recentlyViewed(tx, actor),
        };
      },
    );
  }

  /**
   * "I opened this record."
   *
   * A write the client makes, rather than something the GET does for it: a
   * read that writes turns every record page into a write transaction and
   * rules out serving reads from a replica later. The server still checks
   * that the caller may read what they claim to have opened, so this cannot
   * be used to stash an id from another tenant and have it rendered back
   * with a label.
   */
  async recordView(actor: Actor, input: RecordViewCreateInput): Promise<void> {
    await this.database.runInTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      async (tx) => {
        const target = await this.recordLinks.resolve(tx, actor, input.objectType, input.recordId);
        if (target === null) throw new NotFoundError(input.objectType);

        await this.views.touch(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          userId: actor.userId,
          objectType: input.objectType,
          recordId: input.recordId,
        });
        await this.views.trim(tx, actor.tenantId, actor.userId, RECENTLY_VIEWED_KEEP);
      },
    );
  }

  /**
   * The records this person opened recently, as they can see them now.
   *
   * Re-resolved on every read rather than trusting the stored label: a record
   * can be deleted, reassigned out of the viewer's scope, or have the field
   * the label was built from hidden since. Anything that no longer resolves
   * is dropped from the list rather than shown as a dead row.
   */
  private async recentlyViewed(tx: Tx, actor: Actor): Promise<RecentlyViewedItem[]> {
    const rows = await this.views.recent(tx, actor.tenantId, actor.userId, RECENTLY_VIEWED_KEEP);
    if (rows.length === 0) return [];

    const resolved = await this.recordLinks.resolveMany(
      tx,
      actor,
      rows.map((row) => ({
        objectType: row.objectType as 'account' | 'contact' | 'lead' | 'deal',
        recordId: row.recordId,
      })),
    );

    const items: RecentlyViewedItem[] = [];

    for (const row of rows) {
      const target = resolved.get(keyFor(row.objectType, row.recordId));
      if (target === undefined) continue;
      items.push({ ...target, viewedAt: row.viewedAt.toISOString() });
      if (items.length === RECENTLY_VIEWED_LIMIT) break;
    }

    return items;
  }

  /**
   * The zone to cut the day on.
   *
   * The client may say — a browser knows where it is and a stored profile can
   * be stale — but an unrecognised zone is a 422 rather than a quiet fall
   * back to UTC, which would shift the whole screen by a day without saying
   * so. Falling back to the profile, and then to UTC, only when nothing was
   * asked for.
   */
  private async resolveTimeZone(
    tx: Tx,
    actor: Actor,
    requested: string | undefined,
  ): Promise<TimeZone> {
    if (requested !== undefined) {
      if (!isTimeZone(requested)) {
        throw new ValidationError([{ path: 'timeZone', message: 'Unknown time zone' }]);
      }
      return requested;
    }

    const preferences = await this.activities.userPreferences(tx, actor.userId);
    const stored = preferences?.timezone;
    return stored !== undefined && isTimeZone(stored) ? stored : ('UTC' as TimeZone);
  }

  private windowFor(
    timeZone: TimeZone,
    date: string | undefined,
  ): { date: PlainDate; start: Date; end: Date } {
    if (date === undefined) return dayWindowFor(new Date(), timeZone);

    if (!isPlainDate(date)) {
      throw new ValidationError([{ path: 'date', message: 'Not a valid calendar date' }]);
    }
    return { date, start: startOfDayIn(date, timeZone), end: endOfDayIn(date, timeZone) };
  }
}
