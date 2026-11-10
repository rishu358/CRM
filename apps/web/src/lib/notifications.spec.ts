import { describe, expect, it } from 'vitest';
import { recordPath, type NotificationRecord } from './notifications';

const ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d';

const notification = (type: string, payload: Record<string, unknown>): NotificationRecord => ({
  id: 'n1',
  type,
  payload,
  readAt: null,
  createdAt: '2026-11-10T10:00:00.000Z',
});

describe('where a notification leads (ADR-0077)', () => {
  it('opens the record a reply was filed on, for each kind of record an email is sent from', () => {
    expect(
      recordPath(notification('email.reply_received', { objectType: 'contact', recordId: ID })),
    ).toBe(`/contacts/${ID}`);
    expect(
      recordPath(notification('email.reply_received', { objectType: 'lead', recordId: ID })),
    ).toBe(`/leads/${ID}`);
    expect(
      recordPath(notification('email.reply_received', { objectType: 'deal', recordId: ID })),
    ).toBe(`/deals/${ID}`);
  });

  it('leads nowhere for any other kind of notification, which only read, as they always have', () => {
    for (const type of [
      'activity.assigned',
      'activity.due',
      'lead.web_form_new',
      'something.new',
    ]) {
      expect(
        recordPath(notification(type, { objectType: 'contact', recordId: ID })),
        type,
      ).toBeNull();
    }
  });

  it.each([
    ['an id that is not one', { objectType: 'contact', recordId: '../admin' }],
    ['an id with a path in it', { objectType: 'contact', recordId: `${ID}/../x` }],
    ['an upper-case id', { objectType: 'contact', recordId: ID.toUpperCase() }],
    ['no id', { objectType: 'contact' }],
    ['an id that is not text', { objectType: 'contact', recordId: 7 }],
    ['a kind of record we do not link to', { objectType: 'account', recordId: ID }],
    ['a kind that is a built-in property name', { objectType: 'constructor', recordId: ID }],
    ['a kind that is not text', { objectType: 5, recordId: ID }],
    ['no kind', { recordId: ID }],
  ])(
    'leads nowhere for %s, so nothing a payload carries can choose an address',
    (_what, payload) => {
      expect(recordPath(notification('email.reply_received', payload))).toBeNull();
    },
  );
});
