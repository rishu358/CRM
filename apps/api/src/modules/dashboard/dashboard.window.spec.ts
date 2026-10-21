import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DatabaseService } from '../../database/database.service.js';
import { startApiHarness, type ApiHarness } from '../../testing/harness.js';
import { DealsRepository } from '../deals/deals.repository.js';

/**
 * The company's month, asked at moments the real clock cannot be made to be
 * (MVP_SPEC M10, ADR-0038).
 *
 * The other dashboard specs prove a window starts at midnight on the first in the
 * company's zone — which a window cut on UTC would also do, except for the few
 * hours around a month turn when the two calendars disagree. That is exactly when
 * a company in Auckland or Los Angeles would see last month's wins presented as
 * this month's, so it is pinned here by asking the repository for the window as
 * at a chosen instant.
 */
let harness: ApiHarness;
let tenantId: string;
let repository: DealsRepository;
let database: DatabaseService;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Window Co' })).tenantId;
  repository = harness.app.get(DealsRepository, { strict: false });
  database = harness.app.get(DatabaseService, { strict: false });
});

afterAll(async () => {
  await harness.close();
});

function windowAt(timeZone: string, instant: string) {
  return database.runInTenant({ tenantId, userId: null }, async (tx) => {
    const window = await repository.monthWindow(tx, timeZone, new Date(instant));
    return {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      previousStart: window.previousStart.toISOString(),
    };
  });
}

describe('the month window, at the turn of a month', () => {
  it('is already October in Kolkata when UTC still says September', async () => {
    // 20:00Z on 30 September is 01:30 on 1 October in Asia/Kolkata (+05:30).
    expect(await windowAt('Asia/Kolkata', '2026-09-30T20:00:00Z')).toEqual({
      start: '2026-09-30T18:30:00.000Z',
      end: '2026-10-31T18:30:00.000Z',
      previousStart: '2026-08-31T18:30:00.000Z',
    });
  });

  it('is still September in Los Angeles when UTC already says October', async () => {
    // 03:00Z on 1 October is 20:00 on 30 September in America/Los_Angeles (-07:00).
    expect(await windowAt('America/Los_Angeles', '2026-10-01T03:00:00Z')).toEqual({
      start: '2026-09-01T07:00:00.000Z',
      end: '2026-10-01T07:00:00.000Z',
      previousStart: '2026-08-01T07:00:00.000Z',
    });
  });

  it('follows the clocks going back: a month that has an extra hour is an hour longer', async () => {
    // Los Angeles leaves daylight time on 1 November 2026; October starts at -07:00
    // and November at -08:00.
    const window = await windowAt('America/Los_Angeles', '2026-10-15T12:00:00Z');
    expect(window.start).toBe('2026-10-01T07:00:00.000Z');
    expect(window.end).toBe('2026-11-01T07:00:00.000Z');
    const november = await windowAt('America/Los_Angeles', '2026-11-15T12:00:00Z');
    expect(november.start).toBe('2026-11-01T07:00:00.000Z');
    expect(november.end).toBe('2026-12-01T08:00:00.000Z');
  });

  it('is the same window in UTC as in a zone with no offset, and a year boundary is no special case', async () => {
    expect(await windowAt('UTC', '2027-01-01T00:00:00Z')).toEqual({
      start: '2027-01-01T00:00:00.000Z',
      end: '2027-02-01T00:00:00.000Z',
      previousStart: '2026-12-01T00:00:00.000Z',
    });
  });

  it('puts a +14:00 zone a day ahead of the world', async () => {
    // Pacific/Kiritimati: 10:00Z on 31 October is already 00:00 on 1 November.
    const window = await windowAt('Pacific/Kiritimati', '2026-10-31T10:00:00Z');
    expect(window.start).toBe('2026-10-31T10:00:00.000Z');
    expect(window.end).toBe('2026-11-30T10:00:00.000Z');
  });
});
